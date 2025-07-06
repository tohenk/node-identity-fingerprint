/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2023-2025 Toha <tohenk@yahoo.com>
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

const { Worker } = require('@ntlab/identity');
const Queue = require('@ntlab/work/queue');
const dpfp = require('@ntlab/dplib');
const debug = require('debug')('identity:worker:fingerprint');

const identifyCount = dpfp.getIdentificationLen();
let queue = null;
let stop = false;

function verify(work, start, end) {
    log('FP> [%d] Verifying %s from %d to %d', Worker.id, work.id, start, end);
    const fps = [];
    let count = 0;
    let matched = null;
    let current = start;
    while (current <= end && !stop) {
        const data = {
            start: current,
            fmds: []
        }
        for (let i = 0; i < identifyCount; i++) {
            if (current + i > end) {
                break;
            }
            data.fmds.push(work.items[current + i]);
        }
        fps.push(data);
        current += identifyCount;
    }
    const errNext = err => {
        error('FP> [%d] Err: %s', Worker.id, err);
        if (queue) {
            queue.next();
        }
    }
    queue = new Queue(fps, d => {
        try {
            count += d.fmds.length;
            dpfp.identify(work.feature, d.fmds)
                .then(idx => {
                    if (idx >= 0) {
                        log('FP> [%d] Found matched at %d', Worker.id, d.start + idx);
                        matched = d.start + idx;
                        queue.done();
                    } else if (queue) {
                        queue.next();
                    }
                })
                .catch(err => errNext(err))
            ;
        }
        catch (err) {
            errNext(err);
        }
    });
    queue.once('done', () => {
        queue = null;
        log('FP> [%d] Done verifying %d sample(s)', Worker.id, count);
        Worker.send({cmd: 'done', work: work, matched: matched, worker: Worker.id});
    });
}

function log(...args) {
    debug(...args);
}

function error(...args) {
    debug(...args);
}

Worker.on('message', (data) => {
    switch (data.cmd) {
        case 'do':
            stop = false;
            verify(data.work, data.start, data.end);
            break;
        case 'stop':
            stop = true;
            if (queue) {
                log('FP> [%d] Stopping queue', Worker.id);
                queue.clear();
                queue.done();
            }
            break;
    }
});
