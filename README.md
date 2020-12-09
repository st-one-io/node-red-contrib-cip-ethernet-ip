# node-red-contrib-cip-ethernet-ip

A Node-RED node to interact with Allen Bradley / Rockwell PLCs using the EtherNet/IP protocol.
Based on the awesome work of [cmseaton42/node-ethernet-ip](https://github.com/cmseaton42/node-ethernet-ip).

This node was created as part of the [ST-One](https://st-one.io) project.

## Install

You can install this node directly from the "Manage Palette" menu in the Node-RED interface.

Alternatively, run the following command in your Node-RED user directory - typically `~/.node-red` on Linux or `%HOMEPATH%\.nodered` on Windows

        npm install node-red-contrib-cip-ethernet-ip

NodeJS version 10 or greater and Node-RED version 1.0 or greater is required.


## Usage

Each connection to a PLC is represented by the **ETH-IP Endpoint** configuration node. You can configure the PLC's Address, the variables available and their addresses, and the cycle time for reading the variables.

The **ETH-IP In** node makes the variable's values available in a flow in three different modes:

*   **Single variable:** A single variable can be selected from the configured variables, and a message is sent every cycle, or only when it changes if _diff_ is checked. `msg.payload` contains the variable's value and `msg.topic` has the variable's name.
*   **All variables, one per message:** Like the _Single variable_ mode, but for all variables configured. If _diff_ is checked, a message is sent everytime any variable changes. If _diff_ is unchecked, one message is sent for every variable, in every cycle. Care must be taken about the number of messages per second in this mode.
*   **All variables:** In this mode, `msg.payload` contains an object with all configured variables and their values. If _diff_ is checked, a message is sent if at least one of the variables changes its value.


## Disclaimer

The Software is provided "AS IS", without warranty of any kind. The Licensor makes no warranty that the Software is free of defects or is suitable for any particular purpose. In no event shall the Licensor be responsible for loss or damages arising from the installation or use of the Software


## Bugs and enhancements

Please share your ideas and experiences on the [Node-RED forum](https://discourse.nodered.org/), or open an issue on the [page of the project on GitHub](https://github.com/st-one-io/node-red-contrib-cip-ethernet-ip)


## Support

Community support is offered on a best-effort basis via GitHub Issues. For commercial support, please contact us by sending an e-mail to [st-one@st-one.io](mailto:st-one@st-one.io).


## License
Copyright: (c) 2016-2020, ST-One Ltda., Guilherme Francescon Cittolin <guilherme@st-one.io>

GNU General Public License v3.0+ (see [LICENSE](LICENSE) or https://www.gnu.org/licenses/gpl-3.0.txt)

