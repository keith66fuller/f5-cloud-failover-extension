/**
 * Copyright 2018 F5 Networks, Inc.
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

const f5CloudLibs = require('@f5devcentral/f5-cloud-libs');

const util = require('./util.js');
const Logger = require('./logger.js');
const Validator = require('./validator.js');

const logger = new Logger(module);
const BigIp = f5CloudLibs.bigIp;
const bigip = new BigIp({ logger });

const cloudUtils = f5CloudLibs.util;

const DFL_CONFIG_IN_STATE = {
    config: {}
};

class ConfigWorker {
    constructor() {
        this.state = DFL_CONFIG_IN_STATE;
        this.validator = new Validator();

        this._restWorker = null;
    }

    /**
     * Initialize (state, etc.)
     *
     * @param {Object} restWorker
     */
    init(restWorker) {
        this._restWorker = restWorker;

        return new Promise((resolve, reject) => {
            this._restWorker.loadState(null, (err, state) => {
                if (err) {
                    const message = `error loading state: ${err.message}`;
                    logger.warning(message);
                    reject(err);
                }
                resolve(state);
            });
        })
            .then((state) => {
                this.state = state || DFL_CONFIG_IN_STATE;
            })
            .then(() => bigip.init(
                'localhost',
                'admin',
                'admin',
                {
                    port: '443',
                    product: 'BIG-IP'
                }
            ))
            .then(() => {
                logger.debug('BIG-IP has been initialized');
            })
            .catch((err) => {
                logger.error(`Could not initialize state: ${util.stringify(err.message)}`);
                return Promise.reject(err);
            });
    }

    /**
     * Get Configuration
     *
     */
    getConfig() {
        return Promise.resolve(this.state.config);
    }

    /**
     * Set Configuration
     *
     * @param {Object} config
     */
    setConfig(config) {
        this.state.config = config;

        // save to persistent storage
        return new Promise((resolve, reject) => {
            this._restWorker.saveState(null, this.state, (err) => {
                if (err) {
                    reject(err);
                }
                resolve();
            });
        })
            .catch((err) => {
                logger.error(`Could not set config: ${util.stringify(err.message)}`);
                return Promise.reject(err);
            });
    }

    /**
     * Update the failover trigger scripts, stored on the BIG-IP's local filesystem, to call the Failover
     * Extension 'trigger' endpoint upon a failover event
     *
     * @returns {Promise}   A promise which is resolved when the request is complete
     *                      or rejected if an error occurs.
     */
    updateTriggerScripts() {
        return Promise.all([
            this.executeBigIpBashCmd(this.generateTriggerScript('tgactive')),
            this.executeBigIpBashCmd(this.generateTriggerScript('tgrefresh'))
        ])
            .then(() => {
                logger.info('Successfully wrote Failover trigger scripts to filesystem');
            })
            .catch((err) => {
                logger.error(`Could not update Failover trigger scripts: ${util.stringify(err.message)}`);
                return Promise.reject(err);
            });
    }

    /**
     * Generate the Bash command used to update the Failover Trigger scripts on the BIG-IP's local filesystem
     *
     * @param {String}  scriptName  - Name of the specific failover trigger script to update
     *
     * @returns {String}    A string containing the fully composed bash script
     *                      to send to the iControl util/bash endpoint
     */
    generateTriggerScript(scriptName) {
        // base64 username and password to reduce needs to escape potential special characters
        const auth = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
        // single quotes in Bash command are replaced. Use Hex code for single quote, 27, instead
        const singleQuoteFunc = 'function sq() { printf 27 | xxd -r -p; }';
        const curlCommand = `curl -H $(sq)Authorization: ${auth}$(sq) localhost:8100/mgmt/shared/cloud-failover/trigger`;
        // eslint-disable-next-line no-useless-escape
        return `'${singleQuoteFunc} && printf \"#!/bin/sh\n\n${curlCommand}\n\" > /config/failover/${scriptName}'`;
    }

    /**
     * Calls the util/bash iControl endpoint, to execute a bash script, using the BIG-IP client
     *
     * @param {String}      command - Bash command for BIG-IP to execute
     *
     * @returns {Promise}   A promise which is resolved when the request is complete
     *                      or rejected if an error occurs.
     */
    executeBigIpBashCmd(command) {
        const commandBody = {
            command: 'run',
            utilCmdArgs: `-c ${command}`
        };
        // TODO: util.NO_RETRY is undef. Import it
        return bigip.create('/tm/util/bash', commandBody, undefined, cloudUtils.NO_RETRY);
    }

    /**
     * Process Configuration
     *
     * @param {Object} body
     */
    processConfigRequest(body) {
        const declaration = Object.assign({}, body);
        const validation = this.validator.validate(declaration);

        if (!validation.isValid) {
            const error = new Error(`Invalid declaration: ${JSON.stringify(validation.errors)}`);
            return Promise.reject(error);
        }

        logger.debug('Successfully validated declaration');
        this.setConfig(declaration);

        // update failover trigger scripts
        return this.updateTriggerScripts()
            // eslint-disable-next-line arrow-body-style
            .then(() => {
                return Promise.resolve(this.state.config);
            })
            .catch((err) => {
                logger.error(`Could not process configuration declaration: ${JSON.stringify(err.message)}`);
                return Promise.reject(err);
            });
    }
}

// initialize singleton
module.exports = new ConfigWorker();
