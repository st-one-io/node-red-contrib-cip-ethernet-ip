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
        /** @type {Map<string,eip.Structure>} */
        const tags = new Map();
        const tagGroup = new TagGroup();

        /** @type {eip.Controller} */
        let plc;
        let status;
        let connectTimeoutTimer;
        let cycleTimer;
        let cycleInProgress = 0;
        let tagChanged = false;
        let needsWrite = false;
        let connected = false;
        let closing = false;

        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of listener nodes
        this.setMaxListeners(0);

        //Create tags
        config.vartable = config.vartable || {};
        for (const prog of Object.keys(config.vartable)) {

            for (const varname of Object.keys(config.vartable[prog])) {
                if(!varname){
                    //skip empty values
                    continue;
                }

                const obj = config.vartable[prog][varname];
                const type = (obj.type || '').toString().toUpperCase();
                const dt = Types[type] || null;

                if (isVerbose) {
                    node.log(RED._("ethip.info.tagregister") + `: Name:[${varname}], Prog:[${prog}], Type:[${dt}](${type})`);
                }

                if (!Tag.isValidTagname(varname)){
                    node.warn(RED._("ethip.warn.invalidtagname", {name: varname}));
                    continue;
                }
                
                const tag = new Structure(varname, null, prog || null, dt);
                
                tag.on('Initialized', onTagChanged);
                tag.on('Changed', onTagChanged);
                
                tags.set(`${prog}:${varname}`, tag);
                tagGroup.add(tag);
            }
        }

        node.getStatus = () => status;
        node.getTag = t => tags.get(t);
        node.getTags = () => tags;
        node.getAllTagValues = () => {
            let res = {};

            tagGroup.forEach(tag => {
                res[tag.name] = tag.controller_value;
            });

            return res;
        };

        node.setNeedsWrite = () => needsWrite = true;

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

                if (needsWrite) {
                    await plc.writeTagGroup(tagGroup);
                    needsWrite = false;
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
            clearTimeout(connectTimeoutTimer);
            manageStatus('online');

            connected = true;
            cycleInProgress = 0;

            try {
                const taglist = new TagList();
                await plc.getControllerTagList(taglist);
                
                tags.forEach(t => t.updateTaglist(taglist));
            } catch (e) {
                console.log(e);
                node.warn(RED._('ethip.warn.notaglist'));
            }

            cycleTimer = setInterval(doCycle, parseInt(config.cycletime) || 500);
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
            clearTimeout(connectTimeoutTimer);
            clearInterval(cycleTimer);
            manageStatus('offline');

            connected = false;

            // don't restart if we're closing...
            if(closing) {
                return;
            }
            
            //reset tag values, in case we're dropping the connection because of a wrong value
            if (plc) {
                plc.forEach((tag) => {
                    tag.value = null;
                });
            }

            //try to reconnect if failed to connect
            connectTimeoutTimer = setTimeout(connect, 5000);
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
            clearTimeout(connectTimeoutTimer);
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
            clearTimeout(connectTimeoutTimer);

            // don't restart if we're closing...
            if(closing) return;

            if (plc) {
                closeConnection();
            }

            manageStatus('connecting');

            if (isVerbose) {
                node.log(RED._("ethip.info.connect") + `: ${config.address} / ${config.slot}`);
            }

            connected = false;
            plc = new Controller(false, { unconnectedSendTimeout: 5064 });
            plc.autoBrowseTags = false;
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

        if (config.mode === 'single') {
            let tagName = `${config.program}:${config.variable}`;
            tag = node.endpoint.getTag(tagName);

            if (!tag) {
                //shouldn't reach here. But just in case..
                return node.error(RED._("ethip.error.invalidvar", {
                    varname: tagName
                }));
            }

            tag.on('Initialized', onChanged);
            tag.on('Changed', onChanged);
        } else if (config.mode === 'all-split') {
            node.endpoint.on('#__CHANGED__', onChanged);
        } else {
            node.endpoint.on('#__ALL_CHANGED__', onChangedAllValues);
        }

        node.status(generateStatus("connecting", ""));

        node.endpoint.on('#__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('#__ALL_CHANGED__', onChanged);
            node.endpoint.removeListener('#__ALL_CHANGED__', onChangedAllValues);
            node.endpoint.removeListener('#__STATUS__', onEndpointStatus);
            if (tag) {
                tag.removeListener('Initialized', onChanged);
                tag.removeListener('Changed', onChanged);
            }
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

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        function onNewMsg(msg, send, done) {
            //the actual write will be performed by the scan cycle
            //of the Controller on the endpoint
            tag.value = statusVal = msg.payload;
            node.endpoint.setNeedsWrite();
            // we currently have no feedback of the written value, so
            // let's just call done() here
            done();

            node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        }

        let tagName = `${config.program}:${config.variable}`;
        tag = node.endpoint.getTag(tagName);

        if (!tag) {
            //shouldn't reach here. But just in case..
            return node.error(RED._("ethip.error.invalidvar", {
                varname: tagName
            }));
        }

        node.status(generateStatus("connecting", ""));

        nrInputShim(node, onNewMsg);
        node.endpoint.on('#__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('#__STATUS__', onEndpointStatus);
            done();
        });

    }
    RED.nodes.registerType("eth-ip out", EthIpOut);
};