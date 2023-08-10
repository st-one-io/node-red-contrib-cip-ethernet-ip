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
    const { Controller, Tag, TagGroup, Structure, TagList, Browser, ControllerManager} = eip;
    const { Types } = eip.EthernetIP.CIP.DataTypes;
    const { EventEmitter } = require('events');

    // ---------- Ethernet-IP Browser ----------

    const browser = new Browser();

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
        let plcManager;
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
            if (plc) {
                

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
                        const tag = plc.addTag(varname, prog || null);

                        tag.on('Initialized', onTagChanged);
                        tag.on('Changed', onTagChanged);

                        tags.set(tagName, tag);
                    }
                }

                node.emit('#__NEW_TAGS__');
            }
        }

        node.getStatus = () => status;
        node.getTag = t => tags.get(t);
        node.getTags = () => tags;
        node.getAllTagValues = () => {
            let res = {};

            if (plc.PLC) {
            plc.PLC.forEach(tag => {
                res[tag.name] = tag.value;
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
            node.emit('#__ALL_CHANGED__');
            tagChanged = false;   
        }

        async function onConnect() {
            createTags();
            connected = true;
            manageStatus('online');
            
           
        }


        function onControllerError(err) {
            manageStatus('offline');
            let errStr = err instanceof Error ? err.toString() : JSON.stringify(err);
            node.error(RED._("ethip.error.onerror") + errStr, {});
        }

        

        // close the connection and remove tag listeners
        function onNodeClose(done) {
            manageStatus('offline');
            connected = false;
            closing = true;
            
            
            for (let tag of tags.values()) {
                tag.removeListener('Initialized', onTagChanged);
                tag.removeListener('Changed', onTagChanged);
            }
            plc.removeListener("Error", onControllerError);
            plc.removeListener("Connected", onConnect)
            plc.disconnect().then(done);
        }

        function connect() {
            connected = false;
            plcManager = new ControllerManager()
            plc = plcManager.addController(config.address, Number(config.slot) || 0, parseInt(config.cycletime) || 100, config.connectedMess, 5000, { unconnectedSendTimeout: 5064 })
            plc.connect()
            manageStatus('connecting');

            if (isVerbose) {
                node.log(RED._("ethip.info.connect") + `: ${config.address} / ${config.slot}`);
            }

            plc.on("Error", onControllerError);
            plc.on("Connected", onConnect)
            
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
            let data = tag.value;
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
                console.log('Ethip In')
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

    // PLC, Tag Browser
    RED.httpAdmin.get("/eth-ip", RED.auth.needsPermission("eth-ip.read"), function(req,res) {
        res.json(browser.deviceList)
    });

    const browsedPLC = new Controller(false);
    RED.httpAdmin.post("/eth-ip-tag", RED.auth.needsPermission("eth-ip.write"), function(req,res) {
        browsedPLC.connect(req.body.plcAddress)
        .then(() => {
            res.json(browsedPLC.tagList)
            browsedPLC.disconnect()
        })
    }); 

};
