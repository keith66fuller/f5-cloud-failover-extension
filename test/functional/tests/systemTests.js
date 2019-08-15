/*
 * Copyright 2019. F5 Networks, Inc. See End User License Agreement ("EULA") for
 * license terms. Notwithstanding anything to the contrary in the EULA, Licensee
 * may copy and modify this software product for its internal business purposes.
 * Further, Licensee may upload, publish and distribute the modified version of
 * the software product on devcentral.f5.com.
 */

'use strict';

/* eslint-disable global-require */

const assert = require('assert');
const mustache = require('mustache'); /* eslint-disable-line import/no-extraneous-dependencies */

const constants = require('../../constants.js');
const utils = require('../../shared/util.js');

const environmentInfo = utils.getEnvironmentInfo();
const duts = utils.getHostInfo();
const dutPrimary = duts.filter(dut => dut.primary)[0];
const dutSecondary = duts.filter(dut => !dut.primary)[0];

const packageDetails = utils.getPackageDetails();
const packageFile = packageDetails.name;
const packagePath = packageDetails.path;

const exampleDeclaration = require('./shared/exampleDeclaration.json');

[dutPrimary, dutSecondary].forEach((dut) => {
    describe(`DUT - ${dut.ip} (${dut.primary})`, () => {
        const dutHost = dut.ip;
        const dutUser = dut.username;
        const dutPassword = dut.password;

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

        it('should uninstall package (if exists)', () => {
            const packageName = constants.PKG_NAME;
            return utils.queryPackages(dutHost, authToken)
                .then((data) => {
                    data = data.queryResponse || [];
                    return Promise.resolve(data.filter(pkg => pkg.packageName.includes(packageName)));
                })
                .then(pkgs => Promise.all(pkgs
                    .map(pkg => utils.uninstallPackage(dutHost, authToken, pkg.packageName))))
                .catch(err => Promise.reject(err));
        });

        it(`should install package: ${packageFile}`, () => {
            const fullPath = `${packagePath}/${packageFile}`;
            return utils.installPackage(dutHost, authToken, fullPath)
                .catch(err => Promise.reject(err));
        });

        it('should verify installation', function () {
            this.retries(10);
            const uri = `${constants.BASE_ENDPOINT}/info`;

            return utils.makeRequest(dutHost, uri, options)
                .then((data) => {
                    data = data || {};
                    assert.strictEqual(data.message, 'success');
                })
                .catch(err => Promise.reject(err));
        });

        it('should post declaration', () => {
            const uri = `${constants.BASE_ENDPOINT}/declare`;

            options.method = 'POST';
            options.body = mustache.render(utils.stringify(exampleDeclaration), {
                deploymentId: environmentInfo.deploymentId,
                environment: environmentInfo.environment
            });
            return utils.makeRequest(dutHost, uri, options)
                .then((data) => {
                    data = data || {};
                    assert.strictEqual(data.message, 'success');
                })
                .catch(err => Promise.reject(err));
        });
    });
});
