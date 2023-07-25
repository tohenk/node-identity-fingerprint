/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2023 Toha <tohenk@yahoo.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const { Identity } = require('@ntlab/identity');
const path = require('path');
const util = require('util');
const JSZip = require('jszip');
const debug = require('debug')('identity:fingerprint');

class FingerprintId extends Identity {

    VERSION = 'FPIDENTITY-1.0'

    init() {
        super.init();
        this.ready = false;
        this.id = 'FP';
        this.proxyServerId = 'FPIDENTITY';
        this.enrollWithSamples = typeof this.options.enrollWithSamples !== 'undefined' ?
            this.options.enrollWithSamples : true;
        this.workerOptions = {
            worker: path.join(__dirname, 'worker'),
            maxWorks: 160,
        }
        this.dp = require('@ntlab/dplib');
        if (this.dp.init(this.options.dpInitOptions || {})) {
            this.getIdentifier();
            this.featuresLen = this.dp.getFeaturesLen();
            this.ready = true;
        }
    }

    finalize() {
        this.dp.exit();
    }

    getCommands() {
        return {
            [Identity.MODE_ALL]: {
                'self-test': data => this.VERSION,
                'connect': data => this.ready,
            },
            [Identity.MODE_BRIDGE]: {
                'required-features': data => {
                    return this.featuresLen;
                },
                'set-options': data => {
                    if (undefined !== data.enrollWithSamples) {
                        this.enrollWithSamples = data.enrollWithSamples;
                        return true;
                    }
                    return false;
                },
                'acquire': data => {
                    this.doOp(this.ID_ACQUIRE);
                    return true;
                },
                'enroll': data => {
                    this.doOp(this.ID_ENROLL);
                    return true;
                },
                'stop': data => {
                    this.doOp(this.ID_STOP);
                    return true;
                },
            },
            [Identity.MODE_VERIFIER]: {
                'identify': data => {
                    return this.fingerIdentify(data.feature, data.workid);
                },
                'count-template': data => {
                    return {count: this.getIdentifier().count()};
                },
                'reg-template': data => {
                    if (data.id && data.template) {
                        if (data.force && this.getIdentifier().has(data.id)) {
                            this.getIdentifier().remove(data.id);
                        }
                        const success = this.getIdentifier().add(data.id, data.template);
                        debug(`Register template ${data.id} [${success ? 'OK' : 'FAIL'}]`);
                        if (success) {
                            return {id: data.id};
                        }
                    }
                },
                'unreg-template': data => {
                    if (data.id) {
                        const success = this.getIdentifier().remove(data.id);
                        debug(`Unregister template ${data.id} [${success ? 'OK' : 'FAIL'}]`);
                        if (success) {
                            return {id: data.id};
                        }
                    }
                },
                'has-template': data => {
                    if (data.id) {
                        const success = this.getIdentifier().has(data.id);
                        if (success) {
                            return {id: data.id};
                        }
                    }
                },
                'clear-template': data => {
                    this.getIdentifier().clear();
                    return true;
                }
            }
        }
    }

    doOp(op) {
        if (this.ready) {
            const stopAcquire = callback => {
                this.setStatus('Stopping acquire');
                if (this.dp.isAcquiring()) {
                    this.dp.stopAcquire(() => {
                        this.setStatus('Acquire stopped');
                        callback();
                    });
                } else {
                    this.setStatus('Stop not required');
                    callback();
                }
            }
            const startAcquire = () => {
                this.setStatus('Starting acquire');
                if (op === this.ID_ENROLL) {
                    this.fingers = [];
                }
                let xstatus = null;
                this.dp.startAcquire(op === this.ID_ENROLL ? true : false, (status, data) => {
                    switch (status) {
                    case 'disconnected':
                        if (xstatus != status) {
                            xstatus = status;
                            this.setStatus('Connect fingerprint reader', true);
                            this.sendMessage(this.getPrefix(op === this.ID_ENROLL ? 'enroll-status' : 'acquire-status'), {status: status});
                        }
                        break;
                    case 'connected':
                        if (xstatus != status) {
                            xstatus = status;
                            this.setStatus('Swipe your finger', true);
                            this.sendMessage(this.getPrefix(op === this.ID_ENROLL ? 'enroll-status' : 'acquire-status'), {status: status});
                        }
                        break;
                    case 'error':
                        this.setStatus('Error occured, try again', true);
                        this.sendMessage(this.getPrefix(op === this.ID_ENROLL ? 'enroll-status' : 'acquire-status'), {status: status});
                        break;
                    case 'complete':
                        if (op === this.ID_ENROLL) {
                            this.setStatus('Enroll completed', true);
                            this.fingers.push(data);
                            this.sendMessage(this.getPrefix('enroll-complete'), {data: data});
                        } else {
                            this.setStatus('Acquire completed', true);
                            stopAcquire(() => {
                                this.sendMessage(this.getPrefix('acquire-complete'), {data: data});
                            });
                        }
                        break;
                    case 'enrolled':
                        this.setStatus('Enroll finished', true);
                        stopAcquire(() => {
                            const zip = new JSZip();
                            zip.file('TMPL', data);
                            if (this.enrollWithSamples) {
                                for (let i = 0; i < this.fingers.length; i++) {
                                    zip.file(util.format('S%s', i + 1), this.fingers[i]);
                                }
                            }
                            zip.generateAsync({type: 'nodebuffer'})
                                .then(buffer => {
                                    this.setStatus('Notify for enroll finished');
                                    this.sendMessage(this.getPrefix('enroll-finished'), {template: buffer});
                                })
                            ;
                        });
                        break;
                    }
                });
            }
            // main operation
            stopAcquire(() => {
                if (op !== this.ID_STOP) {
                    startAcquire();
                }
            });
        }
    }

    normalize(data) {
        if (typeof data === 'string') {
            const buff = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
                buff[i] = data.charCodeAt(i);
            }
            data = buff;
        }
        if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
            data = data.buffer;
        }
        return data;
    }

    fingerIdentify(feature, workid) {
        return this.getIdentifier().identify(this.fixWorkId(workid), feature);
    }

    fixWorkId(workid) {
        if (!workid) {
            workid = this.genId();
        }
        return workid;
    }

    onreset() {
        this.doCmd(this.getPrefix('clear-template'));
    }
}

module.exports = FingerprintId;