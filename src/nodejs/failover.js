/**
 * Copyright 2020 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const Device = require('./device.js');
const logger = require('./logger.js');
const util = require('./util.js');
const configWorker = require('./config.js');
const CloudFactory = require('./providers/cloudFactory.js');
const constants = require('./constants.js');

const failoverStates = constants.FAILOVER_STATES;
const deviceStatus = constants.BIGIP_STATUS;
const stateFileName = constants.STATE_FILE_NAME;
const stateFileContents = {
    taskState: failoverStates.PASS,
    message: '',
    timestamp: new Date().toJSON(),
    instance: '',
    failoverOperations: {}
};
const RUNNING_TASK_MAX_MS = 10 * 60000; // 10 minutes

class FailoverClient {
    constructor() {
        this.device = new Device();
        this.cloudProvider = null;
        this.hostname = null;
        this.config = null;
        this.addressDiscovery = null;
        this.routeDiscovery = null;
        this.recoverPreviousTask = null;
        this.recoveryOperations = null;
        this.hasActiveTrafficGroups = null;
        this.isAddressOperationsEnabled = null;
        this.isRouteOperationsEnabled = null;
    }

    /**
     * Get Config from configWorker and initialize this.cloudProvider using the config
     */
    init() {
        logger.debug('Performing failover - initialization');

        return configWorker.getConfig()
            .then((data) => {
                logger.debug(`config: ${util.stringify(data)}`);

                this.config = data;
                if (!this.config || !this.config.environment) {
                    const errorMessage = 'Environment information has not been provided';
                    return Promise.reject(new Error(errorMessage));
                }

                this.cloudProvider = CloudFactory.getCloudProvider(this.config.environment, { logger });
                return this.cloudProvider.init(this._parseConfig());
            })
            .then(() => this.device.init())
            .then(() => {
                logger.silly('Failover initialization complete');
            })
            .catch((err) => {
                const errorMessage = `Failover initialization failed: ${util.stringify(err.message)}`;
                logger.error(`${errorMessage} ${util.stringify(err.stack)}`);
                return Promise.reject(new Error(errorMessage));
            });
    }

    /**
     * Execute (primary function)
     */
    execute() {
        this.isAddressOperationsEnabled = this._getOperationEnabledState('failoverAddresses');
        logger.debug('Address operations enabled? ', this.isAddressOperationsEnabled);
        this.isRouteOperationsEnabled = this._getOperationEnabledState('failoverRoutes');
        logger.debug('Route operations enabled? ', this.isRouteOperationsEnabled);
        if (!this.isAddressOperationsEnabled && !this.isRouteOperationsEnabled) {
            logger.info('failoverAddresses and failoverRoutes is not enabled. Will not perform failover execute');
            return Promise.resolve();
        }
        logger.info('Performing failover - execute');
        // reset certain properties on every execute invocation
        this.recoverPreviousTask = false;
        this.hasActiveTrafficGroups = false;

        return this._getDeviceObjects()
            .then((results) => {
                this.hostname = results[0].hostname;
                this.trafficGroupStats = results[1];
                this.selfAddresses = results[2];
                this.virtualAddresses = results[3];
                this.snatAddresses = results[4];
                this.natAddresses = results[5];

                // wait for task - handles all possible states
                return this._waitForTask();
            })
            .then((taskResponse) => {
                if (taskResponse && taskResponse.recoverPreviousTask === true) {
                    return Promise.resolve(taskResponse);
                }
                return this._createAndUpdateStateObject({
                    taskState: failoverStates.RUN,
                    message: 'Failover running'
                });
            })
            .then((taskResponse) => {
                // return failover recovery if taskResponse is set to recoverPreviousTask for flapping scenario
                if (taskResponse && taskResponse.recoverPreviousTask === true) {
                    return this._getRecoveryOperations(taskResponse);
                }

                const activeTrafficGroups = this._getTrafficGroups(
                    this.trafficGroupStats, this.hostname, deviceStatus.ACTIVE
                );
                if (!activeTrafficGroups.length) {
                    return Promise.resolve([{}, {}]);
                }
                this.hasActiveTrafficGroups = true;
                return this._getFailoverDiscovery(activeTrafficGroups);
            })
            .then((updates) => {
                this.addressDiscovery = updates[0] || {};
                this.routeDiscovery = updates[1] || {};

                return this._createAndUpdateStateObject({
                    taskState: failoverStates.RUN,
                    message: 'Failover running',
                    failoverOperations: {
                        addresses: this.addressDiscovery,
                        routes: this.routeDiscovery
                    }
                });
            })
            .then(() => {
                if (!this.hasActiveTrafficGroups) {
                    // Troubleshooting Notes
                    // - does device hostname (list sys global-settings hostname) match
                    // the device name in configuration management (list cm device)?
                    logger.warning('This device is not active for any traffic groups');
                    logger.silly('Recommend checking the device hostname matches CM device name');
                    return Promise.resolve();
                }
                logger.info('Performing Failover - update');
                const updateActions = [];
                if (this.isAddressOperationsEnabled) {
                    logger.debug(`Address discovery: ${util.stringify(this.addressDiscovery)}`);
                    updateActions.push(this.cloudProvider.updateAddresses({ updateOperations: this.addressDiscovery }));
                }
                if (this.isRouteOperationsEnabled) {
                    logger.debug(`Route discovery: ${util.stringify(this.routeDiscovery)}`);
                    updateActions.push(this.cloudProvider.updateRoutes({ updateOperations: this.routeDiscovery }));
                }
                return Promise.all(updateActions);
            })
            .then(() => this._createAndUpdateStateObject({
                taskState: failoverStates.PASS,
                message: 'Failover Complete',
                failoverOperations: {
                    addresses: this.addressDiscovery,
                    routes: this.routeDiscovery
                }
            }))
            .then(() => {
                logger.info('Failover Complete');
            })
            .catch((err) => {
                logger.error(`${util.stringify(err.message)} ${util.stringify(err.stack)}`);
                return this._createAndUpdateStateObject({
                    taskState: failoverStates.FAIL,
                    message: `Failover failed because ${util.stringify(err.message)}`,
                    failoverOperations: {
                        addresses: this.addressDiscovery,
                        routes: this.routeDiscovery
                    }
                })
                    .then(() => Promise.reject(err))
                    .catch(() => Promise.reject(err));
            });
    }

    /**
     * Reset Failover State (delete data in cloud storage)
     *
     * @returns {Promise} - { message: 'some message' }
     */
    resetFailoverState(body) {
        const stateComponents = Object.assign({}, body);
        if (stateComponents.resetStateFile === true) {
            // reset state file contents
            return this._createAndUpdateStateObject({
                taskState: failoverStates.PASS,
                message: constants.STATE_FILE_RESET_MESSAGE,
                failoverOperations: {}
            })
                .then(() => Promise.resolve({ message: constants.STATE_FILE_RESET_MESSAGE }))
                .catch((err) => {
                    const errorMessage = `failover.resetFailoverState() error: ${util.stringify(err.message)} ${util.stringify(err.stack)}`;
                    logger.error(errorMessage);
                });
        }
        return Promise.resolve({ message: 'No action performed' });
    }

    /**
     * Returns BIG-IP's current HA status and its associated cloud objects
     */
    getFailoverStatusAndObjects() {
        let result = null;
        let hostname = null;
        let trafficGroupStats = null;
        logger.info('Fetching device info');
        return this._getDeviceObjects()
            .then((deviceInfo) => {
                hostname = deviceInfo[0].hostname;
                trafficGroupStats = deviceInfo[1];
                // wait for task - handles all possible states
                return this._waitForTask();
            })
            .then(() => this.cloudProvider.getAssociatedAddressAndRouteInfo())
            .then((addressAndRouteInfo) => {
                logger.debug('Fetching addressAndRouteInfo ', addressAndRouteInfo);
                result = addressAndRouteInfo;
                return Promise.resolve();
            })
            .then(() => {
                logger.debug('Fetching traffic groups');
                const activeTG = this._getTrafficGroups(trafficGroupStats, hostname, deviceStatus.ACTIVE);
                const standByTG = this._getTrafficGroups(trafficGroupStats, hostname, deviceStatus.STANDBY);
                result.hostName = hostname;
                if (activeTG === null || activeTG.length === 0) {
                    result.deviceStatus = deviceStatus.STANDBY;
                    result.trafficGroup = standByTG;
                } else {
                    result.deviceStatus = deviceStatus.ACTIVE;
                    result.trafficGroup = activeTG;
                }
                return Promise.resolve(result);
            })
            .catch((err) => {
                const errorMessage = `failover.getFailoverStatusAndObjects() error: ${util.stringify(err.message)} ${util.stringify(err.stack)}`;
                logger.error(errorMessage);
            });
    }

    /**
     * Parses config from the declaration that is to be passed to cloud provider init
     */
    _parseConfig() {
        const tags = util.getDataByKey(this.config, 'failoverAddresses.scopingTags');
        const routeTags = util.getDataByKey(this.config, 'failoverRoutes.scopingTags');
        const scopingAddressRanges = util.getDataByKey(this.config, 'failoverRoutes.scopingAddressRanges') || [];
        const routeAddressRanges = [];
        const storageTags = util.getDataByKey(this.config, 'externalStorage.scopingTags');
        for (let scopingAddressIndex = 0;
            scopingAddressIndex < scopingAddressRanges.length;
            scopingAddressIndex += 1) {
            const addressRange = util.getDataByKey(this.config, 'failoverRoutes.scopingAddressRanges')[scopingAddressIndex];
            routeAddressRanges.push({
                routeAddresses: addressRange.range,
                routeNextHopAddresses: this._nextHopAddressResolver(addressRange)
            });
        }
        return {
            tags, routeTags, routeAddressRanges, storageTags
        };
    }

    /**
     * Resolves appropriate next hop addresses if no next hop address is provided and returns the default
     */
    _nextHopAddressResolver(addressRange) {
        if (addressRange.nextHopAddresses) {
            return {
                // Note: type is set to provide default discovery type of 'routeTag' for backwards compatibility...
                type: addressRange.nextHopAddresses.discoveryType || 'routeTag',
                items: addressRange.nextHopAddresses.items || [],
                tag: constants.ROUTE_NEXT_HOP_ADDRESS_TAG
            };
        }
        return {
            type: util.getDataByKey(this.config, 'failoverRoutes.defaultNextHopAddresses.discoveryType') || 'routeTag',
            items: util.getDataByKey(this.config, 'failoverRoutes.defaultNextHopAddresses.items'),
            tag: constants.ROUTE_NEXT_HOP_ADDRESS_TAG
        };
    }

    _getDeviceObjects() {
        return Promise.all([
            this.device.getGlobalSettings(),
            this.device.getTrafficGroupsStats(),
            this.device.getSelfAddresses(),
            this.device.getVirtualAddresses(),
            this.device.getSnatTranslationAddresses(),
            this.device.getNatAddresses()
        ])
            .then(results => Promise.resolve(results))
            .catch((err) => {
                const errorMessage = `failover._getDeviceObjects() error: ${util.stringify(err.message)} ${util.stringify(err.stack)}`;
                logger.error(errorMessage);
            });
    }

    /**
     * Get failover discovery (update cloud provider addresses and routes)
     *
     * @param {Object} trafficGroups - The traffic groups to discover local and failover addresses
     *
     * @returns {Promise}
     */
    _getFailoverDiscovery(trafficGroups) {
        logger.info('Performing Failover - discovery');

        const addresses = this._getFailoverAddresses(
            this._getSelfAddresses(this.selfAddresses, trafficGroups),
            this._getFloatingAddresses(
                this.virtualAddresses, this.snatAddresses, this.natAddresses, trafficGroups
            )
        );
        this.localAddresses = addresses.localAddresses;
        logger.debug('Retrieved local addresses', this.localAddresses);
        this.failoverAddresses = addresses.failoverAddresses;
        logger.debug('Retrieved failover addresses ', this.failoverAddresses);

        const updateActions = [];
        if (this.isAddressOperationsEnabled) {
            updateActions.push(this.cloudProvider.updateAddresses({
                localAddresses: this.localAddresses,
                failoverAddresses: this.failoverAddresses,
                discoverOnly: true
            }));
        }
        if (this.isRouteOperationsEnabled) {
            updateActions.push(this.cloudProvider.updateRoutes({
                localAddresses: this.localAddresses,
                discoverOnly: true
            }));
        }

        return Promise.all(updateActions)
            .catch(err => Promise.reject(err));
    }

    /**
     * Get recovery operations
     *
     * @param {Object} taskResponse - taskResponse with state of the recovery failover operations
     *
     * @returns {Promise}
     */
    _getRecoveryOperations(taskResponse) {
        logger.warning('Performing Failover - recovery');

        this.recoverPreviousTask = true;
        this.recoveryOperations = taskResponse.state.failoverOperations;

        if (!this.recoveryOperations || (!this.recoveryOperations.addresses
            && !this.recoveryOperations.routes)) {
            throw new Error('Recovery operations are empty, advise reset via the API');
        }

        return this._createAndUpdateStateObject({
            taskState: failoverStates.RUN,
            message: 'Failover running'
        })
            .then(() => Promise.resolve([
                this.recoveryOperations.addresses,
                this.recoveryOperations.routes
            ]))
            .catch(err => Promise.reject(err));
    }

    /**
     * Get operations enabled state
     *
     * @param {String} parentConfigKey - the config parent key
     *
     * @returns {boolean}
     */
    _getOperationEnabledState(parentConfigKey) {
        if (util.getDataByKey(this.config, `${parentConfigKey}`) == null) {
            return false;
        }
        if (util.getDataByKey(this.config, `${parentConfigKey}.enabled`) == null) {
            return true; // backwards compatibility requires this
        }
        return util.getDataByKey(this.config, `${parentConfigKey}.enabled`);
    }

    /**
     * Create state object
     *
     * @param {Object} [options]            - function options
     * @param {String} [options.taskState]  - task state
     * @param {String} [options.failoverOperations] - failover operations
     * @param {String} [options.message] - task state message
     *
     * @returns {Object}
     */
    _createStateObject(options) {
        const thisState = util.deepCopy(stateFileContents);
        thisState.taskState = options.taskState || failoverStates.PASS;
        thisState.timestamp = new Date().toJSON();
        thisState.instance = this.hostname || 'none';
        thisState.failoverOperations = options.failoverOperations;
        thisState.message = options.message || '';
        return thisState;
    }

    /**
     * Create and update state object
     *
     * @param {Object} [options]                    - function options
     * @param {String} [options.taskState]          - task state
     * @param {String} [options.failoverOperations] - failover operations
     * @param {String} [options.message]            - task state message
     *
     * @returns {Promise} - resolves with the state object uploaded
     */
    _createAndUpdateStateObject(options) {
        const taskState = options.taskState || failoverStates.PASS;
        const failoverOperations = options.failoverOperations || {};
        const message = options.message || '';
        const stateObject = this._createStateObject({ taskState, failoverOperations, message });

        return this.cloudProvider.uploadDataToStorage(stateFileName, stateObject)
            .then(() => Promise.resolve(stateObject))
            .catch((err) => {
                logger.error(`uploadDataToStorage error: ${util.stringify(err.message)}`);
                return Promise.reject(err);
            });
    }

    /**
     * Get task state file
     *
     * @returns {Promise}
     */
    getTaskStateFile() {
        return this.cloudProvider.downloadDataFromStorage(stateFileName)
            .then((data) => {
                logger.silly(`Download stateFile: ${util.stringify(data)}`);

                // initial case - failover has never occurred
                if (!data || !data.taskState) {
                    return this._createAndUpdateStateObject({
                        taskState: failoverStates.NEVER_RUN,
                        message: 'Failover has never been triggered'
                    });
                }

                return Promise.resolve(data);
            })
            .catch(err => Promise.reject(err));
    }

    /**
     * Check task state
     *
     * @returns {Promise}
     */
    _checkTaskState() {
        return this.cloudProvider.downloadDataFromStorage(stateFileName)
            .then((data) => {
                logger.silly('State file data: ', data);

                // initial case - simply return empty object
                if (!data || !data.taskState) {
                    return Promise.resolve({ recoverPreviousTask: false, state: data });
                }
                // never run - no need to wait for task
                if (data.taskState === failoverStates.NEVER_RUN) {
                    return Promise.resolve({ recoverPreviousTask: false, state: data });
                }
                // success - no need to wait for task
                if (data.taskState === failoverStates.PASS) {
                    return Promise.resolve({ recoverPreviousTask: false, state: data });
                }
                // failed - recover previous task
                if (data.taskState === failoverStates.FAIL) {
                    return Promise.resolve({ recoverPreviousTask: true, state: data });
                }
                // enforce maximum time allotment
                const timeDrift = new Date() - Date.parse(data.timeStamp);
                if (timeDrift > RUNNING_TASK_MAX_MS) {
                    logger.error(`Time drift exceeded maximum limit: ${timeDrift}`);
                    return Promise.resolve({ recoverPreviousTask: true, state: data });
                }
                // default reponse - reject and retry
                return Promise.reject(new Error('retry'));
            })
            .catch(err => Promise.reject(err));
    }

    /**
     * Wait for task to complete (or fail/timeout)
     *
     * @returns {Promise} { recoverPreviousTask: false, state: {} }
     */
    _waitForTask() {
        // retry every 3 seconds, up to 20 minutes (_checkTaskState has it's own timer)
        const options = { maxRetries: 400, retryInterval: 3 * 1000, thisArg: this };

        return util.retrier(this._checkTaskState, [], options)
            .catch(err => Promise.reject(err));
    }

    /**
     * Get traffic groups (local)
     *
     * @param {Object} trafficGroupStats - The traffic group stats as returned by the device
     * @param {String} hostname          - The hostname of the device
     * @param {String} failoverStatus    - failover status of the device
     *
     * @returns {Object} traffic groups this device is active for
     */
    _getTrafficGroups(trafficGroupStats, hostname, failoverStatus) {
        const trafficGroups = [];

        const entries = trafficGroupStats.entries;
        Object.keys(entries).forEach((key) => {
            const local = entries[key].nestedStats.entries.deviceName.description.indexOf(hostname) !== -1
                && entries[key].nestedStats.entries.failoverState.description === failoverStatus;

            if (local) {
                trafficGroups.push({
                    name: entries[key].nestedStats.entries.trafficGroup.description
                });
            }
        });
        return trafficGroups;
    }

    /**
     * Get self addresses
     *
     * @param {Object} selfAddresses - Self addresses
     * @param {Object} trafficGroups - Traffic groups
     *
     * @returns {Object}
     */
    _getSelfAddresses(selfAddresses, trafficGroups) {
        const addresses = [];
        selfAddresses.forEach((item) => {
            let trafficGroupMatch = false;
            trafficGroups.forEach((nestedItem) => {
                if (nestedItem.name.indexOf(item.trafficGroup) !== -1) {
                    trafficGroupMatch = true;
                }
            });

            addresses.push({
                address: item.address.split('/')[0].split('%')[0],
                trafficGroup: item.trafficGroup,
                trafficGroupMatch
            });
        });
        return addresses;
    }

    /**
     * Get (all) floating addresses from multiple address types
     *
     * @param {Object} virtualAddresses - Virtual addresses
     * @param {Object} snatAddresses    - SNAT (translation) addresses
     * @param {Object} natAddresses     - NAT addresses
     * @param {Object} trafficGroups    - Traffic groups
     *
     * @returns {Object}
     */
    _getFloatingAddresses(virtualAddresses, snatAddresses, natAddresses, trafficGroups) {
        const addresses = [];

        // helper function to add address (as needed)
        const _addAddress = (item, addressKey) => {
            const address = item[addressKey].split('%')[0];
            const addressTrafficGroup = item.trafficGroup;

            trafficGroups.forEach((nestedItem) => {
                if (nestedItem.name.indexOf(addressTrafficGroup) !== -1) {
                    addresses.push({
                        address
                    });
                }
            });
        };

        virtualAddresses.forEach((item) => {
            _addAddress(item, 'address');
        });
        snatAddresses.forEach((item) => {
            _addAddress(item, 'address');
        });
        natAddresses.forEach((item) => {
            _addAddress(item, 'translationAddress');
        });
        return addresses;
    }

    /**
     * Get failover addresses
     *
     * @param {Object} selfAddresses     - Self addresses (floating and non-floating)
     * @param {Object} floatingAddresses - Floating addresses
     *
     * @returns {Object}
     */
    _getFailoverAddresses(selfAddresses, floatingAddresses) {
        const localAddresses = [];
        const failoverAddresses = [];
        logger.debug('Getting failover addresses using selfAddresses ', selfAddresses, ' and floatingAddresses ', floatingAddresses);
        // go through all self addresses and add address to appropriate array
        selfAddresses.forEach((item) => {
            if (item.trafficGroupMatch) {
                failoverAddresses.push(item.address);
            } else {
                localAddresses.push(item.address);
            }
        });
        // always add all floating addresses to failover address array
        floatingAddresses.forEach((item) => {
            failoverAddresses.push(item.address);
        });

        return {
            localAddresses,
            failoverAddresses
        };
    }
}

module.exports = {
    FailoverClient
};
