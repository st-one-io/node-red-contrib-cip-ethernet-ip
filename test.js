const {Controller, Tag} = require('ethernet-ip');

let PLC = new Controller();
//let PLC_IP = "192.168.15.6";
let PLC_IP = "172.18.0.1";
let PLC_SLOT = 0;

function setListener(evt){
    PLC.on(evt, (data) => console.log(`>> [${evt}]:`, data));
}

function logErr(e) {
    console.log('>> ERROR:', e);
}

function log(d){
    console.log('>> DONE:', d);
}

setListener('Get Attribute Single');
setListener("Get Attribute All");
setListener("Set Attribute Single");
setListener("Read Tag");
setListener("Read Tag Fragmented");
setListener("Write Tag");
setListener("Write Tag Fragmented");
setListener("Read Modify Write Tag");

setListener("error");
setListener("connect");
setListener("connected");
setListener("disconnect");
setListener("disconnected");
setListener("destroy");
setListener("end");

PLC.connect(PLC_IP, PLC_SLOT).then((d) => {
    console.log("Connection successfull");
}).catch((e) => {
    console.log("Error connecting:", e);
});

let t = new Tag("Teste");