"use strict";

const {SerialPort} = require("serialport");
const {ByteLengthParser} = require('@serialport/parser-byte-length');
let util = require("util"),
events = require('events');
const {usb} = require('usb');

function BelCanto() {
    this.seq = 0;
    this.volume = -1
    console.log("[BelCanto lib.js] creating BelCanto instance");
}

util.inherits(BelCanto, events.EventEmitter);

let _processw = function () {
    if (!this._port)
        return
    if (this._woutstanding)
        return
    if (this._qw.length == 0)
        return

    this._woutstanding = true;
    /*if(this._qw[0].length <= 4)
        console.log("[BelCanto] writing", this._qw[0].length, ":",
            this._qw[0][0].toString(16),
            this._qw[0][1].toString(16),
            this._qw[0][2].toString(16),
            this._qw[0][3].toString(16))
    else
        console.log("[BelCanto] writing", this._qw[0].length, ":",
            this._qw[0][0].toString(16),
            this._qw[0][1].toString(16),
            this._qw[0][2].toString(16),
            this._qw[0][3].toString(16),
            this._qw[0][4].toString(16))
    */

    this._port.write(
        this._qw[0],
        (err) => {
            if (err)
                return;
            this._qw.shift();
            this._woutstanding = false;
            setTimeout(() => {
                _processw.call(this);
            }, 150);
        });
}

function send(val, cb) {
    this._qw.push(val);
    _processw.call(this);
};

// codes from
// https://www.plaudio.com/pdf/docs/Belcanto%20AMiP%20RS232%20Codes%20v1.2.pdf
// https://www.manualslib.com/manual/15208/Bel-Canto-Pl-1.html?page=71#manual

// packet construction
const DLE = 0x10
const XORCHR = 0x40

// first byte Flag
const FLAG = 0x7e

// second byte Type
const TYPE_MSB = 0x80
const TYPE_ACKNACK = 0x20   // 1=Ack/Nack in data[0], 0=other
const  ACK = 0x06
const  NACK = 0x15
const TYPE_SIZE_MASK = 0x0f // number of data bytes - 1

// third byte Command
const COMMAND_MSB = 0x80
const COMMAND_READ = 0x40   // 1=Read, 0=Write
const COMMAND_MASK = 0x3f
const COMMAND = {
    Display:2, Mute:3, Input:5, Volume:7, Balance:9, AckRxWrite:100, NackRxWrite:101
}

// subsequent bytes are Data

// final byte is Checksum (Type + Command + Data[]) Mod 256 (<before> DLE suppression)

const MUTE = {
    OFF:0xe0, ON:0xe1, SOFT:0xe2
}

function make_tx_command(command, data, read_not_write=false) {
    if(command == COMMAND.AckRxWrite)
        return make_tx_command_(rx_packet.command, TYPE_ACKNACK, [ACK], false)
    else if(command == COMMAND.NackRxWrite)
        return make_tx_command_(rx_packet.command, TYPE_ACKNACK, [NACK], false)
    else
        return make_tx_command_(command, 0, data, read_not_write)
}
function make_tx_command_(command, type, data, read_not_write) {
    if(typeof(data) == "number")
        data = [data]
    let datacount = data.length
    if(datacount > 0)
        datacount -= 1

    let cmd = [FLAG]

    let type_byte = TYPE_MSB | type | datacount
    cmd.push(type_byte)

    let command_byte = COMMAND_MSB | (read_not_write?COMMAND_READ:0) | command
    cmd.push(command_byte)
    for(let i = 0; i <= datacount; ++i) {
        let b = data[i]
        if((b == DLE) || (b == FLAG)) {
            cmd.push(DLE)
            b ^= XORCHR
        }
        cmd.push(b)
    }

    let checksum = type_byte
    checksum += command_byte
    for(let i = 0; i <= datacount; ++i) {
        checksum += data[i]
    }
    cmd.push(checksum % 256)

    return cmd
}

// the most recent received data, separated into fields
let rx_packet = {
    type:0, command:0, data:[], checksum:0
}
const RX_PACKET_STATE = { rx_idle:0, rx_type:1, rx_command:2, rx_data:3, rx_data_dle:4, rx_checksum:5, rx_checksum_dle:6 }
let rx_packet_state = RX_PACKET_STATE.rx_idle
let rx_packet_datalen = 0

function parse_rx_byte(b)
{
    let result = null
    let error_string = ""

    switch(rx_packet_state) {
    case RX_PACKET_STATE.rx_idle:
        if(b == FLAG)
            rx_packet_state = RX_PACKET_STATE.rx_type
        break;
    case RX_PACKET_STATE.rx_type:
        if((b & TYPE_MSB) == TYPE_MSB) {
            rx_packet.checksum = b
            rx_packet.type = b
            rx_packet_datalen = (b & TYPE_SIZE_MASK) + 1
            if((rx_packet_datalen >= 0) && (rx_packet_datalen < 16))
                rx_packet_state = RX_PACKET_STATE.rx_command
            else
                rx_packet_state = RX_PACKET_STATE.rx_idle
        } else {
            rx_packet_state = RX_PACKET_STATE.rx_idle
        }
        break;
    case RX_PACKET_STATE.rx_command:
        if(((b & COMMAND_MSB) == COMMAND_MSB) || ((rx_packet.type & TYPE_ACKNACK) == TYPE_ACKNACK)) {
            rx_packet.command = b
            rx_packet.checksum += b

            rx_packet_state = RX_PACKET_STATE.rx_data
        } else {
            rx_packet_state = RX_PACKET_STATE.rx_idle
        }
        break;
    case RX_PACKET_STATE.rx_data:
        if(b != DLE) {
            if(rx_packet_datalen > 0) {
                --rx_packet_datalen
                rx_packet.data[rx_packet_datalen] = b
                rx_packet.checksum += b

                if(rx_packet_datalen == 0)
                    rx_packet_state = RX_PACKET_STATE.rx_checksum
            } else
                rx_packet_state = RX_PACKET_STATE.rx_idle
        }
        else {
            rx_packet_state = RX_PACKET_STATE.rx_data_dle   // throw away this DLE byte and "fix" the next one
        }
        break;
    case RX_PACKET_STATE.rx_data_dle:
        --rx_packet_datalen
        let corrected_b = b ^ XORCHR
        rx_packet.data[rx_packet_datalen] = corrected_b
        rx_packet.checksum += corrected_b

        if(rx_packet_datalen == 0)
            rx_packet_state = RX_PACKET_STATE.rx_checksum
        else
            rx_packet_state = RX_PACKET_STATE.rx_data
        break;
    case RX_PACKET_STATE.rx_checksum:
        if(b != DLE) {
            if(b == rx_packet.checksum % 256)
                result = rx_packet
            else
                error_string = "[BelCanto] received invalid checksum"
            rx_packet_state = RX_PACKET_STATE.rx_idle
        } else {
            rx_packet_state = RX_PACKET_STATE.rx_checksum_dle
        }
        break;
    case RX_PACKET_STATE.rx_checksum_dle:
        corrected_b = b ^ XORCHR
        if(corrected_b == rx_packet.checksum % 256)
            result = rx_packet
        else
            rx_packet_state = RX_PACKET_STATE.rx_idle
        break;
    }

    if(error_string)
        console.log(error_string)
    if(error_string && result)
        console.log(
            rx_packet.type.toString(16),
            rx_packet.command.toString(16),
            rx_packet.data[0].toString(16),
            rx_packet.checksum.toString(16),
            b)

    return result    // null if not done with a full and correct packet
}

function display_to_bc_volume(vol100) {
    if(vol100 >= 80)
        return 200 + (vol100 - 100)
    else
        return 180 + (vol100 -  80) * 2
}
function bc_volume_to_display(vol200) {
    if(vol200 >= 180)
        return 100 + (vol200 - 200)
    else
        return 80 + (vol200 - 180) / 2
}

BelCanto.prototype.volume_up = function () {
    if(this.volume < 0)
        send.call(this, make_tx_command(COMMAND.Volume, 0, true))
    else
        send.call(this, make_tx_command(COMMAND.Volume, display_to_bc_volume(this.volume + 1)));
};
BelCanto.prototype.volume_down = function () {
    if(this.volume < 0)
        send.call(this, make_tx_command(COMMAND.Volume, 0, true))
    else
        send.call(this, make_tx_command(COMMAND.Volume, display_to_bc_volume(this.volume - 1)));
};
BelCanto.prototype.set_volume = function (val) {
    console.log("[BelCanto lib.js] prototype.set_volume", val, this.properties.volume);
    //if (this.properties.volume == val)
    //    return;
    if (this.volumetimer)
        clearTimeout(this.volumetimer);
    this.volumetimer = setTimeout(() => {
        let bc_volume = display_to_bc_volume(val)
        let s = make_tx_command(COMMAND.Volume, bc_volume)
        console.log("[BelCanto lib.js] executing prototype.set_volume", bc_volume, s);
        send.call(this, s);
    }, 50)
};
BelCanto.prototype.get_status = function () {
    // unimplemented
};
BelCanto.prototype.power_off = function () {
    // unimplemented
};
BelCanto.prototype.power_on = function () {
    // unimplemented
};
BelCanto.prototype.set_source = function (val) {
    send.call(this, make_tx_command(COMMAND.Input, val));
};
BelCanto.prototype.mute = function (val) {
    send.call(this, make_tx_command(COMMAND.Mute, val));
};

BelCanto.prototype.raw_command = function (val) {
    // unimplemented
};

BelCanto.prototype.init = function (opts, closecb) {
    let self = this;

    this._qw = [];
    this._woutstanding = false;

    this.properties = {
        volume: opts.volume || 1,
        mute:   opts.mute || true,
        input:  opts.input || '8',
    };

    this.initializing = true;
    this.serialCommandMode = "Zone";

    this._port = new SerialPort({
        path: opts.port,
        baudRate: opts.baud || 115200
    });
    this._parser = new ByteLengthParser({
        length: 1
    });
    this._port.pipe(this._parser);

    this._parser.on('data', data => {
        if (this.initializing) {
            this.initializing = false;
            this.emit('connected');
        }

        let rx = parse_rx_byte(data[0])
        if(rx != null)
        {
            console.log("[BelCanto] rx packet", rx.command & COMMAND_MASK, rx.data[0],
                (rx.type & TYPE_ACKNACK)? (rx.data[0]==ACK)? "ACK" : "NACK" : "")

            if((rx.type & TYPE_ACKNACK) != TYPE_ACKNACK)
            {
                let val = rx.data[0]

                switch(rx.command & COMMAND_MASK) {
                case COMMAND.Display:
                    console.log('[BelCanto] rx ignored Display');
                    break;
                case COMMAND.Mute:
//                    if (this.properties.source != val) {
                        console.log('[BelCanto] rx mute: %s', val);
                        this.properties.source = val;
                        this.emit('mute', val);
//                    }
                    break;
                case COMMAND.Input:
//                    if (this.properties.source != val) {
                        console.log('[BelCanto] rx source: %s', val);
                        this.properties.source = val;
                        this.emit('source', val);
//                    }
                    break;
                case COMMAND.Volume:
//                    if (this.properties.volume != val) {
                        let display_volume = bc_volume_to_display(val)
                        console.log('[BelCanto] rx volume: %d to %d', this.properties.volume, display_volume);
                        this.properties.volume = display_volume;
                        this.emit('volume', display_volume);
//                    }
                    break;
                case COMMAND.Balance:
                    console.log('[BelCanto] rx ignored Balance');
                    break;
                default:
                    console.log("[BelCanto] rx ignored unknown command", rx.command.toString(16))
                    break;
                }
            }
        }
    });

    let timer = setTimeout(() => {
        if (this.initializing) {
            this.initializing = false;
            this.emit('connected');
        }
    }, 3000);
    this._port.on('open', err => {
        this.emit('preconnected');
        let val = "Standby";
        this.properties.source = val;
        //get volume in case device is running (QRY does not report volume, so we need to use a 'trick')
        send.call(this, make_tx_command(COMMAND.Volume, 0, true))
    });

    //detection of BelCanto USB disconnection (at power-off)
    usb.on('detach', device => {
        if (this.properties.usbVid == device.deviceDescriptor.idVendor) {
            console.log('remove', device);
            let val = "Standby";
            if (this.properties.source != val) {
                this.properties.source = val;
                this.emit('source', val);
            }
        }
    });

    this._port.on('close', () => {
        this._port.close(() => {
            this._port = undefined;
            if (closecb) {
                var cb2 = closecb;
                closecb = undefined;
                cb2('close');
            }
        })
    });
    this._port.on('error', err => {
        this._port.close(() => {
            this._port = undefined;
            if (closecb) {
                var cb2 = closecb;
                closecb = undefined;
                cb2('error');
            }
        })
    });
    this._port.on('disconnect', () => {
        this._port.close(() => {
            this._port = undefined;
            if (closecb) {
                var cb2 = closecb;
                closecb = undefined;
                cb2('disconnect');
            }
        })
    });
};

BelCanto.prototype.start = function (opts) {
    this.seq++;

    let closecb = (why) => {
        this.emit('disconnected');
        if (why != 'close') {
            var seq = ++this.seq;
            setTimeout(() => {
                if (seq != this.seq)
                    return;
                this.start(opts);
            }, 1000);
        }
    };

    if (this._port) {
        this._port.close(() => {
            this.init(opts, closecb);
        });
    } else {
        this.init(opts, closecb);
    }
};

BelCanto.prototype.stop = function () {
    this.seq++;
    if (this._port)
        this._port.close(() => {});
};

exports = module.exports = BelCanto;
