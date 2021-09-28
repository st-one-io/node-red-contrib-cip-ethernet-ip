//@ts-check
/*
  Copyright: (c) 2016-2020, St-One Ltda., Guilherme Francescon Cittolin <guilherme@st-one.io>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

const net = require('net');

function nrInputShim(node, fn) {
    function doErr(err) { err && node.error(err) }
    node.on('input', function (msg, send, done) {
        send = send || node.send;
        done = done || doErr;
        fn(msg, send, done);
    });
}

module.exports = function (RED) {
    "use strict";

    const eip = require('st-ethernet-ip');
    const { Controller, Tag, TagGroup, Structure, TagList } = eip;
    const { Types } = eip.EthernetIP.CIP.DataTypes;
    const { EventEmitter } = require('events');

    // ---------- Ethernet-IP Endpoint ----------

    function generateStatus(status, val) {
        let obj;

        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._("ethip.endpoint.status.online");
        }

        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'badvalues':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("ethip.endpoint.status.badvalues")
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._("ethip.endpoint.status.offline")
                };
                break;
            case 'error':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._("ethip.endpoint.status.error")
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("ethip.endpoint.status.connecting")
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._("ethip.endpoint.status.unknown")
                };
        }
        return obj;
    }

    function EthIpEndpoint(config) {
        EventEmitter.call(this);
        const node = this;
        const isVerbose = RED.settings.get('verbose');
        /** @type {Map<string,eip.Structure|eip.Tag>} */
        const tags = new Map();
        const taglist = new TagList();

        /** @type {eip.Controller} */
        let plc;
        let status;
        let reconnectTimer;
        let cycleTimer;
        let cycleInProgress = 0;
        let tagChanged = false;
        let needsWrite = [];
        let connected = false;
        let closing = false;
        let tagGroup;

        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of listener nodes
        this.setMaxListeners(0);

        //Create tags
        config.vartable = config.vartable || {};
        const timeout = parseInt(config.timeout) || 10000;

        function createTags() {
            const group = new TagGroup();

            if (plc) {
                tags.clear();

                for (const prog of Object.keys(config.vartable)) {

                    for (const varname of Object.keys(config.vartable[prog])) {
                        if (!varname) {
                            //skip empty values
                            continue;
                        }

                        const obj = config.vartable[prog][varname];
                        const type = (obj.type || '').toString().toUpperCase();
                        const dt = Types[type] || null;

                        if (isVerbose) {
                            node.log(RED._("ethip.info.tagregister") + `: Name:[${varname}], Prog:[${prog}], Type:[${dt}](${type})`);
                        }

                        if (!Tag.isValidTagname(varname)) {
                            node.warn(RED._("ethip.warn.invalidtagname", { name: varname }));
                            continue;
                        }

                        const tagName = prog ? `Program:${prog}.${varname}` : varname;
                        const tag = plc.newTag(varname, prog || null, false);

                        tag.on('Initialized', onTagChanged);
                        tag.on('Changed', onTagChanged);

                        tags.set(tagName, tag);
                        group.add(tag);
                    }
                }

                node.emit('#__NEW_TAGS__');
            }

            return group;
        }

        node.getStatus = () => status;
        node.getTag = t => tags.get(t);
        node.getTags = () => tags;
        node.getAllTagValues = () => {
            let res = {};

            if (tagGroup) {
                tagGroup.forEach(tag => {
                    res[tag.name] = tag.controller_value;
                });
            }

            return res;
        };

        /**
         * Adds callback functions of write nodes
         * @param {function} f 
         */
        node.setNeedsWrite = f => needsWrite.push(f);

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            node.emit('#__STATUS__', {
                status: status
            });
        }

        function onTagChanged(tag, lastValue) {
            node.emit('#__CHANGED__', tag, lastValue);
            tagChanged = true;
        }

        function testTagChanged() {
            if (tagChanged) node.emit('#__ALL_CHANGED__');
            tagChanged = false;
        }

        async function doCycle() {
            if (cycleInProgress) {
                cycleInProgress++;
                if (cycleInProgress > 10) {
                    //TODO restart communication;
                }
                return;
            }

            try {
                cycleInProgress = 1;

                if (needsWrite.length) {
                    await plc.writeTagGroup(tagGroup);
                    needsWrite.forEach(f => f());
                    needsWrite = [];
                }

                await plc.readTagGroup(tagGroup);
                testTagChanged();

                cycleInProgress = 0;
            } catch (e) {
                if (!closing) {
                    onControllerError(e);
                }
            }
        }

        async function onConnect() {
            clearTimeout(reconnectTimer);

            tagGroup = createTags();

            connected = true;
            cycleInProgress = 0;
            manageStatus('online');

            cycleTimer = setInterval(doCycle, parseInt(config.cycletime) || 3000);
        }

        function onConnectError(err) {
            let errStr = err instanceof Error ? err.toString() : JSON.stringify(err);
            node.error(RED._("ethip.error.onconnect") + errStr, {});
            onControllerClose();
        }

        function onControllerError(err) {
            let errStr = err instanceof Error ? err.toString() : JSON.stringify(err);
            node.error(RED._("ethip.error.onerror") + errStr, {});
            onControllerClose();
        }

        function onControllerClose() {
            clearTimeout(reconnectTimer);
            clearInterval(cycleTimer);
            manageStatus('offline');

            connected = false;

            // don't restart if we're closing...
            if (closing) {
                return;
            }

            //reset tag values, in case we're dropping the connection because of a wrong value
            if (plc) {
                plc.forEach((tag) => {
                    tag.value = null;
                });
            }

            //try to reconnect if failed to connect
            reconnectTimer = setTimeout(connect, 5000);
        }

        async function destroyPLC() {
            if (plc) {
                // sets "plc" to null before async code, prevents race conditions
                const localPlc = plc;
                plc = null;

                try {
                    await localPlc.disconnect();
                } catch (e) {
                    //TODO emit warning
                    net.Socket.prototype.destroy.call(localPlc);
                }

                localPlc.removeListener("error", onControllerError);
                localPlc.removeListener("end", onControllerClose);
            }
        }

        function closeConnection(done) {
            //ensure we won't try to connect again if anybody wants to close it
            clearTimeout(reconnectTimer);
            clearInterval(cycleTimer);

            if (isVerbose) {
                node.log(RED._("ethip.info.disconnect"));
            }

            manageStatus('offline');
            connected = false;

            destroyPLC().then(() => {
                if (typeof done == 'function') {
                    done();
                }
            });

        }

        // close the connection and remove tag listeners
        function onNodeClose(done) {
            closing = true;
            closeConnection(() => {
                for (let tag of tags.values()) {
                    tag.removeListener('Initialized', onTagChanged);
                    tag.removeListener('Changed', onTagChanged);
                }
                done();
            });
        }

        function connect() {
            //ensure we won't try to connect again if anybody wants to close it
            clearTimeout(reconnectTimer);

            // don't restart if we're closing...
            if (closing) return;

            if (plc) {
                closeConnection();
            }

            manageStatus('connecting');

            if (isVerbose) {
                node.log(RED._("ethip.info.connect") + `: ${config.address} / ${config.slot}`);
            }

            connected = false;
            plc = new Controller(false, { unconnectedSendTimeout: 5064 });
            plc.timeout_sp = timeout;
            plc.on("error", onControllerError);
            plc.on("close", onControllerClose);
            plc.connect(config.address, Number(config.slot) || 0).then(onConnect).catch(onConnectError);
        }

        node.on('close', onNodeClose);
        connect();

    }
    RED.nodes.registerType("eth-ip endpoint", EthIpEndpoint);

    // ---------- Ethernet-IP In ----------

    function EthIpIn(config) {
        const node = this;
        let statusVal, tag;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("ethip.error.missingconfig"));
        }

        const tagName = config.program ? `Program:${config.program}.${config.variable}` : config.variable;

        function onChanged(tag, lastValue) {
            let data = tag.controller_value;
            let key = tag.name || '';
            let msg = {
                payload: data,
                topic: key,
                lastValue: lastValue
            };

            node.send(msg);
            node.status(generateStatus(node.endpoint.getStatus(), config.mode === 'single' ? data : null));
        }

        function onChangedAllValues() {
            let msg = {
                payload: node.endpoint.getAllTagValues()
            };

            node.send(msg);
            node.status(generateStatus(node.endpoint.getStatus()));
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, config.mode === 'single' ? statusVal : null));
        }

        function loadTag() {
            unloadTag();

            tag = node.endpoint.getTag(tagName);

            if (!tag) {
                //shouldn't reach here. But just in case..
                return node.error(RED._("ethip.error.invalidvar", { varname: tagName }));
            }

            tag.on('Initialized', onChanged);
            tag.on('Changed', onChanged);
        }

        function unloadTag() {
            if (tag) {
                tag.removeListener('Initialized', onChanged);
                tag.removeListener('Changed', onChanged);
            }
        }

        node.status(generateStatus(node.endpoint.getStatus(), ""));

        node.endpoint.on('#__STATUS__', onEndpointStatus);

        if (config.mode === 'single') {
            node.endpoint.on('#__NEW_TAGS__', loadTag);
        } else if (config.mode === 'all-split') {
            node.endpoint.on('#__CHANGED__', onChanged);
        } else {
            node.endpoint.on('#__ALL_CHANGED__', onChangedAllValues);
        }

        node.on('close', function (done) {
            node.endpoint.removeListener('#__ALL_CHANGED__', onChanged);
            node.endpoint.removeListener('#__ALL_CHANGED__', onChangedAllValues);
            node.endpoint.removeListener('#__STATUS__', onEndpointStatus);
            node.endpoint.removeListener('#__NEW_TAGS__', loadTag);
            unloadTag();
            done();
        });
    }
    RED.nodes.registerType("eth-ip in", EthIpIn);

    // ---------- Ethernet-IP Out ----------

    function EthIpOut(config) {
        const node = this;
        let statusVal, tag;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("ethip.in.error.missingconfig"));
        }

        const configTagName = config.variable ? (
            config.program ? `Program:${config.program}.${config.variable}` : config.variable
        ) : null;

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        function onNewMsg(msg, send, done) {

            const tagName = configTagName || msg.variable;
            const tag = node.endpoint.getTag(tagName);
            if (!tag) {
                const err = RED._("ethip.error.invalidvar", { varname: tagName });
                done(err);
            } else {
                //the actual write will be performed by the scan cycle
                //of the Controller on the endpoint
                tag.value = statusVal = msg.payload;
                node.endpoint.setNeedsWrite(done);
            }

            node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        }

        node.status(generateStatus(node.endpoint.getStatus(), ""));

        nrInputShim(node, onNewMsg);
        node.endpoint.on('#__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('#__STATUS__', onEndpointStatus);
            done();
        });

    }
    RED.nodes.registerType("eth-ip out", EthIpOut);
};