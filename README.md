# BelCanto Device Control via RS232

The BelCanto RS232 protocol implementation is based on [Belcanto AMiP RS232 Codes v1.2.pdf](https://www.plaudio.com/pdf/docs/Belcanto%20AMiP%20RS232%20Codes%20v1.2.pdf) documentation.

Configure your BelCanto:

* Link speed: 9600
* Identifier: BelCanto

Initialization:

```javascript
var BelCanto = require("node-belcanto");
var d = new BelCanto();
```

Listening to events:

```javascript
d.on('status', function(status) { });
d.on('changed', function(property, value) { });
```

`status` can be one of the following:

* `'connecting'`
* `'initializing'`
* `'connected'`
* `'disconnected'`

`property` can be one of the following:

* `'volume'`
* `'input'`
* `'mute'`

Starting/Stopping the connection to the McIntosh device:

```javascript
d.start(port, baud, port_aux);
```

* `port` should be like `'/dev/cu.usbserial'` or something similar on MacOS or Linux, or `'COM3'` on Windows
* `baud` should be like `9600`

```javascript
d.stop();
```
