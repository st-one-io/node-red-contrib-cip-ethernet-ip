//@ts-check
/*
  Copyright: (c) 2016-2019, Smart-Tech Controle e Automação
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

    const eip = require('ethernet-ip');
    const {
        Controller,
        Tag
    } = eip;
    const {
        EventEmitter
    } = require('events');

    // ---------- Ethernet-IP Endpoint ----------

    function generateStatus(status, val) {
        var obj;

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
        var node = this;
        var status;
        var isVerbose = RED.settings.get('verbose');
        var connectTimeoutTimer;
        var connected = false;
        var closing = false;
        var tags = new Map();

        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of listener nodes
        this.setMaxListeners(0);

        //Create tags
        config.vartable = config.vartable || {};
        for (let prog of Object.keys(config.vartable)) {

            for (let varname of Object.keys(config.vartable[prog])) {
                if(!varname){
                    //skip empty values
                    continue;
                }

                let obj = config.vartable[prog][varname];
                let type = (obj.type || '').toString().toUpperCase();
                let dt = eip.EthernetIP.CIP.DataTypes.Types[type] || null;

                if (isVerbose) {
                    node.log(RED._("ethip.info.tagregister") + `: Name:[${varname}], Prog:[${prog}], Type:[${dt}](${type})`);
                }

                if (!Tag.isValidTagname(varname)){
                    node.warn(RED._("ethip.warn.invalidtagname", {name: varname}));
                    continue;
                }
                
                let tag = new Tag(varname, prog || null, dt);
                
                tag.on('Initialized', onTagChanged);
                tag.on('Changed', onTagChanged);
                
                tags.set(`${prog}:${varname}`, tag);
            }
        }

        node.getStatus = function getStatus() {
            return status;
        };

        node.getTag = function getTag(t) {
            return tags.get(t);
        };

        node.getTags = function getTags(t) {
            return tags;
        };

        node.getAllTagValues = function getAllTagValues() {
            let res = {};

            node._plc.forEach(tag => {
                res[tag.name] = tag.controller_value;
            });

            return res;
        };

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            node.emit('__STATUS__', {
                status: status
            });
        }

        function onTagChanged(tag, lastValue) {
            node.emit('__ALL_CHANGED__', tag, lastValue);
        }

        function onConnect() {
            clearTimeout(connectTimeoutTimer);
            manageStatus('online');

            connected = true;

            for (let t of tags.values()) {
                node._plc.subscribe(t);
            }

            node._plc.scan_rate = parseInt(config.cycletime) || 500;
            node._plc.scan().catch(onScanError);
        }

        function onConnectError(err) {
            let errStr = err instanceof Error ? err.toString() : JSON.stringify(err);
            node.error(RED._("ethip.error.onconnect") + errStr, {});
            onControllerEnd();
        }

        function onControllerError(err) {
            let errStr = err instanceof Error ? err.toString() : JSON.stringify(err);
            node.error(RED._("ethip.error.onerror") + errStr, {});
            onControllerEnd();
        }

        function onScanError(err) {
            if (closing) {
                //closing the connection will cause a timeout error, so let's just skip it
                return;
            }

            //proceed to cleanup and reconnect
            onControllerError(err);
        }

        function onControllerEnd() {
            clearTimeout(connectTimeoutTimer);
            manageStatus('offline');

            connected = false;

            // don't restart if we're closing...
            if(closing) {
                destroyPLC();
                return;
            } else {
                //reset tag values, in case we're dropping the connection because of a wrong value
                node._plc.forEach((tag) => {
                    tag.value = null;
                });
            }

            //try to reconnect if failed to connect
            connectTimeoutTimer = setTimeout(connect, 5000);
        }

        function onControllerClose(err) {
            try {
                node._plc._handleCloseEvent(err);
            } catch (e) {
                node.error(`${RED._("ethip.error.onerror")} ${e.message}`, {});
            }
        }

        function destroyPLC() {
            if (node._plc) {
                node._plc.destroy();
                
                //TODO remove listeners
                node._plc.removeListener("close", onControllerClose);
                node._plc.removeListener("error", onControllerError);
                node._plc.removeListener("end", onControllerEnd);
                net.Socket.prototype.destroy.call(node._plc);
                node._plc = null;
            }
        }

        function closeConnection(done) {
            //ensure we won't try to connect again if anybody wants to close it
            clearTimeout(connectTimeoutTimer);

            if (isVerbose) {
                node.log(RED._("ethip.info.disconnect"));
            }

            manageStatus('offline');
            connected = false;

            destroyPLC();

            if (typeof done == 'function') {
                done();
            }
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

            if (node._plc) {
                closeConnection();
            }

            manageStatus('connecting');

            if (isVerbose) {
                node.log(RED._("ethip.info.connect") + `: ${config.address} / ${config.slot}`);
            }

            connected = false;
            node._plc = new Controller();
            node._plc.removeListener("close", node._plc._handleCloseEvent);
            node._plc.on("close", onControllerClose);
            node._plc.on("error", onControllerError);
            node._plc.on("end", onControllerEnd);
            node._plc.connect(config.address, Number(config.slot) || 0).then(onConnect).catch(onConnectError);
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
            node.endpoint.on('__ALL_CHANGED__', onChanged);
        } else {
            node.endpoint.on('__ALL_CHANGED__', onChangedAllValues);
        }

        node.status(generateStatus("connecting", ""));

        node.endpoint.on('__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('__ALL_CHANGED__', onChanged);
            node.endpoint.removeListener('__ALL_CHANGED__', onChangedAllValues);
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
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
        var node = this;
        var statusVal, tag;
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
        node.endpoint.on('__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
            done();
        });

    }
    RED.nodes.registerType("eth-ip out", EthIpOut);
};
