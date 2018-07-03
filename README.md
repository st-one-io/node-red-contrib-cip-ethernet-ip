node-red-contrib-ethernet-ip
=====================
A Node-RED node to interact with Allen Bradley / Rockwell PLCs.
Based on the awesome work of [cmseaton42/node-ethernet-ip](https://github.com/cmseaton42/node-ethernet-ip).


This is a work in progress. Feedback is alwaws welcome.

<!--
Install
-----------

You can install this node directly from the "Manage Palette" menu in the Node-RED interface. There are no external dependencies or compilation steps.

Alternatively, run the following command in your Node-RED user directory - typically `~/.node-red` on Linux or `%HOMEPATH%\.nodered` on Windows

        npm install node-red-contrib-ethernet-ip

Usage
-----------

Each connection to a PLC is represented by the **S7 Endpoint** configuration node. You can configure the PLC's Address, the variables available and their addresses, and the cycle time for reading the variables.

The **S7 In** node makes the variable's values available in a flow in three different modes:

*   **Single variable:** A single variable can be selected from the configured variables, and a message is sent every cycle, or only when it changes if _diff_ is checked. `msg.payload` contains the variable's value and `msg.topic` has the variable's name.
*   **All variables, one per message:** Like the _Single variable_ mode, but for all variables configured. If _diff_ is checked, a message is sent everytime any variable changes. If _diff_ is unchecked, one message is sent for every variable, in every cycle. Care must be taken about the number of messages per second in this mode.
*   **All variables:** In this mode, `msg.payload` contains an object with all configured variables and their values. If _diff_ is checked, a message is sent if at least one of the variables changes its value.
 -->


TODO
----
 - Add new "control" node to call other PLC functions
   - Get/Set time
   - Get PLC Properties
 - All help sections

License
-----------
Copyright 2016-2018 Smart-Tech, [Apache 2.0 license](LICENSE).
