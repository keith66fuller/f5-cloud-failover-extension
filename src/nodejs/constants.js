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

// the location of package.json changes when going from source control to the
// packaged iLX expected folder structure in the RPM - account for that here
let packageInfo;
try {
    /* eslint-disable global-require */
    /* eslint-disable import/no-unresolved */
    packageInfo = require('../package.json');
} catch (err) {
    packageInfo = require('../../package.json');
}

const PACKAGE_NAME = packageInfo.name;
const PACKAGE_VERSION = packageInfo.version;

/**
 * Constants used across two or more files
 *
 * @module
 */
module.exports = {
    NAME: PACKAGE_NAME,
    VERSION: PACKAGE_VERSION,
    BASE_URL: 'https://localhost/mgmt/shared/cloud-failover',
    MGMT_PORTS: [
        443,
        8443
    ],
    CONTROLS_CLASS_NAME: 'Controls',
    CLOUD_PROVIDERS: {
        AWS: 'aws',
        AZURE: 'azure',
        GCP: 'gcp'
    },
    CONTROLS_PROPERTY_NAME: 'controls',
    ENDPOINTS: {
        CONFIG: 'declare',
        FAILOVER: 'failover',
        TASK: 'task'
    },
    FAILOVER_CLASS_NAME: 'Failover',
    FEATURE_FLAG_KEY_NAMES: {
        IP_FAILOVER: 'failoverAddresses',
        ROUTE_FAILOVER: 'failoverRoutes'
    },
    ENVIRONMENT_KEY_NAME: 'environment',
    LOCAL_HOST: 'localhost',
    MASK_REGEX: new RegExp('pass(word|phrase)', 'i'),
    PATHS: {
        tgactive: '/config/failover/tgactive',
        tgrefresh: '/config/failover/tgrefresh'
    },
    STATUS: {
        STATUS_OK: 'OK',
        STATUS_ERROR: 'ERROR',
        STATUS_ROLLING_BACK: 'ROLLING_BACK',
        STATUS_RUNNING: 'RUNNING'
    },
    TELEMETRY_TYPE: `${PACKAGE_NAME}-data`,
    TELEMETRY_TYPE_VERSION: '1',
    NAMELESS_CLASSES: [
    ],
    STORAGE_FOLDER_NAME: 'f5cloudfailover',
    STATE_FILE_NAME: 'f5cloudfailoverstate.json',
    FAILOVER_STATES: {
        PASS: 'SUCCEEDED',
        FAIL: 'FAILED',
        RUN: 'RUNNING'
    },
    BIGIP_STATUS: {
        ACTIVE: 'active',
        STANDBY: 'standby'
    },
    NIC_TAG: 'f5_cloud_failover_nic_map',
    ROUTE_NEXT_HOP_ADDRESS_TAG: 'f5_self_ips',
    GCP_LABEL_NAME: 'f5_cloud_failover_labels',
    GCP_FWD_RULE_PAIR_LABEL: 'f5_target_instance_pair',
    AWS_VIPS_TAG: 'VIPS',
    MAX_RETRIES: 20,
    RETRY_INTERVAL: 10000,
    TRIGGER_COMMENT: '# Autogenerated by F5 Failover Extension - Triggers failover',
    TRIGGER_COMMAND: 'curl -u admin:admin -d {} -X POST http://localhost:8100/mgmt/shared/cloud-failover/trigger',
    LEGACY_TRIGGER_COMMENT: '# Disabled by F5 Failover Extension',
    LEGACY_TRIGGER_COMMANDS: [
        '/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/failoverProvider.js',
        '/usr/bin/f5-rest-node /config/cloud/gce/node_modules/@f5devcentral/f5-cloud-libs-gce/scripts/failover.js'
    ],
    STATE_FILE_RESET_MESSAGE: 'Failover state file was reset',
    CONTROLS_LOG_LEVEL: 'Log level control config posted',
    MISSING_CONTROLS_OBJECT: 'Body is missing controls object',
    INSPECT_ADDRESSES_AND_ROUTES: {
        instance: null,
        addresses: [],
        routes: []
    },
    LOG_LEVELS: {
        silly: 0,
        verbose: 1,
        debug: 2,
        info: 3,
        warning: 4,
        error: 5
    }
};
