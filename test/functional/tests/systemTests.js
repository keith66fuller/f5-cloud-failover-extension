/*
 * Copyright 2019. F5 Networks, Inc. See End User License Agreement ("EULA") for
 * license terms. Notwithstanding anything to the contrary in the EULA, Licensee
 * may copy and modify this software product for its internal business purposes.
 * Further, Licensee may upload, publish and distribute the modified version of
 * the software product on devcentral.f5.com.
 */

'use strict';

/* eslint-disable global-require */

const path = require('path');
const assert = require('assert');

const constants = require('../../constants.js');
const utils = require('../../shared/util.js');

const deploymentFile = process.env.CF_DEPLOYMENT_FILE || path.join(process.cwd(), 'deployment_info.json');

/**
 * Get host info
 *
 * @returns {Object} Returns [ { ip: x.x.x.x, username: admin, password: admin } ]
 */
function getHostInfo() {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const hosts = require(deploymentFile).map((item) => {
        item = {
            ip: item.mgmt_address,
            username: item.admin_username,
            password: item.admin_password
        };
        return item;
    });
    return hosts;
}

const duts = getHostInfo();
const dutPrimary = duts[0];

const packageDetails = utils.getPackageDetails();
const packageFile = packageDetails.name;
const packagePath = packageDetails.path;

describe(`DUT - ${dutPrimary.ip}`, () => {
    const dutHost = dutPrimary.ip;
    const dutUser = dutPrimary.username;
    const dutPassword = dutPrimary.password;

    let authToken = null;
    let options = {};

    before(() => {
    });
    beforeEach(() => utils.getAuthToken(dutHost, dutUser, dutPassword)
        .then((data) => {
            authToken = data.token;
            options = {
                headers: {
                    'x-f5-auth-token': authToken
                }
            };
        }));
    after(() => {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
    });

    it(`should install package: ${packageFile}`, () => {
        const fullPath = `${packagePath}/${packageFile}`;
        return utils.installPackage(dutHost, authToken, fullPath)
            .catch(err => Promise.reject(err));
    });

    it('should verify installation', function () {
        this.retries(10);
        const uri = `${constants.BASE_ENDPOINT}/info`;

        return new Promise(resolve => setTimeout(resolve, 1000))
            .then(() => utils.makeRequest(dutHost, uri, options))
            .then((data) => {
                data = data || {};
                assert.strictEqual(data.message, 'success');
            });
    });
});
