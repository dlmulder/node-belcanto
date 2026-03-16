"use strict";

const {SerialPort} = require("serialport");
const {ByteLengthParser} = require('@serialport/parser-byte-length');
let util = require("util"),
events = require('events');
const { buffer } = require("stream/consumers");

function BelCanto() {
    this.seq = 0;
    this.req_bc_volume = -1;   // requested
    this.act_bc_volume1 = -1;  // actual (after a set command has been ACKed)
    this.act_bc_volume2 = -1;
    this.req_bc_mute = null;
    this.act_bc_mute1 = null;
    this.act_bc_mute2 = null;
    this.req_bc_display = null;
    this.act_bc_display1 = null;
    this.act_bc_display2 = null;
    this.req_bc_source = null;
    this.act_bc_source1 = null;
    this.act_bc_source2 = null;
    console.log("[BelCanto lib.js] creating BelCanto instance");
}

util.inherits(BelCanto, events.EventEmitter);

let writeQueue = Promise.resolve()
const writeToPort = (port, data, id) => {
    writeQueue = writeQueue.then(() => {
        return new Promise((resolve, reject) => {
            port.write(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
    return writeQueue;
}

const tx_queue = []
function queue_tx(id, command) {
    tx_queue.push({id: id, command: command})
}
function send_next_tx() {
    if(tx_queue.length > 0) {
        let p = tx_queue.shift()

        if(p.command == COMMAND.Volume) {
            if(this.req_bc_volume != this.act_bc_volume) {
                let s = make_tx_command(COMMAND.Volume, this.req_bc_volume)
                if(p.id == null) {
                    writeToPort(this.port1, s, 1);
                    writeToPort(this.port2, s, 2);
                } else if(p.id == 1)
                    writeToPort(this.port1, s, 1);
                else
                    writeToPort(this.port2, s, 2);
            }
        }
        else if(p.command == COMMAND.Source) {
            if(this.req_bc_source != this.act_bc_source) {
                let s = make_tx_command(COMMAND.Input, this.req_bc_source)
                if(p.id == null) {
                    writeToPort(this.port1, s, 1);
                    writeToPort(this.port2, s, 2);
                } else if(p.id == 1)
                    writeToPort(this.port1, s, 1);
                else
                    writeToPort(this.port2, s, 2);
            }
        }
        else if(p.command == COMMAND.Display) {
            let s = make_tx_command(COMMAND.Display, this.req_bc_display)
            if(p.id == null) {
                writeToPort(this.port1, s, 1);
                writeToPort(this.port2, s, 2);
            } else if(p.id == 1)
                writeToPort(this.port1, s, 1);
            else
                writeToPort(this.port2, s, 2);
        }
        else if(p.command == COMMAND.Mute) {
            if(this.req_bc_mute != this.act_bc_mute) {
                let s = make_tx_command(COMMAND.Mute, this.req_bc_mute);
                if(p.id == null) {
                    writeToPort(this.port1, s, 1);
                    writeToPort(this.port2, s, 2);
                } else if(p.id == 1)
                    writeToPort(this.port1, s, 1);
                else
                    writeToPort(this.port2, s, 2);
            }
        }
    }
}

// codes from
// https://www.plaudio.com/pdf/docs/Belcanto%20AMiP%20RS232%20Codes%20v1.2.pdf
// https://www.manualslib.com/manual/15208/Bel-Canto-Pl-1.html?page=71#manual

// packet construction
const DLE = 0x10
const XORCHR = 0x40

// first byte Flag
const FLAG = 0x7e

// second byte Type
const PACKET_TYPE_INDEX = 0 // the Flag byte is assumed in the code
const TYPE_MSB = 0x80
const TYPE_ACKNACK = 0x20   // 1=Ack/Nack in data[0], 0=other
const  ACK = 0x06
const  NACK = 0x15
const TYPE_SIZE_MASK = 0x0f // number of data bytes - 1

// third byte Command
const PACKET_COMMAND_INDEX = 1
const COMMAND_MSB = 0x80
const COMMAND_READ = 0x40   // 1=Read, 0=Write
const COMMAND_MASK = 0x3f
const COMMAND = {
    Display:2, Mute:3, Input:5, Volume:7, Balance:9, AckRxWrite:100, NackRxWrite:101
}

// subsequent bytes are Data
const PACKET_DATA0_INDEX = 2

// final byte is Checksum (Type + Command + Data[]) Mod 256 (<before> DLE suppression)

const MUTE = {
    OFF:0xe0, ON:0xe1, SOFT:0xe2    // also display ON/OFF
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
    console.log("make_tx data", data)
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

    return Buffer.from(cmd)
}

// the most recent received data
const rx_packet = []
const RX_PACKET_STATE = { rx_idle:0, rx_type:1, rx_command:2, rx_data:3, rx_data_dle:4, rx_checksum:5, rx_checksum_dle:6 }
let rx_packet_checksum = 0
let rx_packet_state = RX_PACKET_STATE.rx_idle
let rx_packet_datalen = 0

function parse_rx_byte(b, id)
{
    let result = null
    let error_string = ""

    switch(rx_packet_state) {
    case RX_PACKET_STATE.rx_idle:
        if(b == FLAG) {
            rx_packet.length = 0
            rx_packet_state = RX_PACKET_STATE.rx_type
        }
        break;
    case RX_PACKET_STATE.rx_type:
        if((b & TYPE_MSB) == TYPE_MSB) {
            rx_packet_checksum = b
            rx_packet.push(b)
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
            rx_packet.push(b)
            rx_packet_checksum += b

            rx_packet_state = RX_PACKET_STATE.rx_data
        } else {
            rx_packet_state = RX_PACKET_STATE.rx_idle
        }
        break;
    case RX_PACKET_STATE.rx_data:
        if(b != DLE) {
            if(rx_packet_datalen > 0) {
                --rx_packet_datalen
                rx_packet.push(b)
                rx_packet_checksum += b

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
        rx_packet.push(corrected_b)
        rx_packet_checksum += corrected_b

        if(rx_packet_datalen == 0)
            rx_packet_state = RX_PACKET_STATE.rx_checksum
        else
            rx_packet_state = RX_PACKET_STATE.rx_data
        break;
    case RX_PACKET_STATE.rx_checksum:
        if(b != DLE) {
            rx_packet_checksum %= 256
            if(b == rx_packet_checksum)
                result = rx_packet
            else
                error_string = "[BelCanto " + id + "] received invalid checksum, got " + b + " expected " + rx_packet_checksum
            rx_packet_state = RX_PACKET_STATE.rx_idle
        } else {
            rx_packet_state = RX_PACKET_STATE.rx_checksum_dle
        }
        break;
    case RX_PACKET_STATE.rx_checksum_dle:
        corrected_b = b ^ XORCHR
        rx_packet.checksum %= 256
        if(corrected_b == rx_packet.checksum)
            result = rx_packet
        else
            rx_packet_state = RX_PACKET_STATE.rx_idle
        break;
    }

    if(error_string)
        console.log(error_string, rx_packet)
    else if(result)
        console.log(id, result)

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

BelCanto.prototype.request_volume = function(vol) {
    this.req_bc_volume = display_to_bc_volume(vol)
    this.set_volume()
}
BelCanto.prototype.request_mute = function(mute) {
    this.req_bc_mute = mute? MUTE.ON : MUTE.OFF
    this.set_mute()
}

BelCanto.prototype.volume_up = function (id=null) {
    return this.set_volume(this.volume + 1, id)
};
BelCanto.prototype.volume_down = function (id=null) {
    return this.set_volume(this.volume - 1, id)
};
BelCanto.prototype.set_volume = function (id=null) {
    queue_tx(id, COMMAND.Volume)
};

BelCanto.prototype.set_source = function (id=null) {
    queue_tx(id, COMMAND.Source)
}
BelCanto.prototype.set_display = function (id=null) {
    queue_tx(id, COMMAND.Display)
};
BelCanto.prototype.set_mute = function (id=null) {
    queue_tx(id, COMMAND.Mute)
};

BelCanto.prototype.init = function (opts, closecb1, closecb2) {
    this.qw1 = [];
    this.qw2 = [];
    this.woutstanding1 = false;
    this.woutstanding2 = false;

    this.properties = { // current values
        volume: null,
        mute: null,
        source: null,
        display: null
    };

    this.initializing = true;

    // port 1
    this.port1 = new SerialPort({
        path: opts.port1,
        baudRate: opts.baud || 9600
    });
    this.parser1 = new ByteLengthParser({
        length: 1
    });
    this.port1.pipe(this.parser1);
    handle_system_events.call(this, 1, this.parser1, this.port1, closecb1)

    // port 2
    if(opts.port2) {
        this.port2 = new SerialPort({
            path: opts.port2,
            baudRate: opts.baud || 9600
        });
        this.parser2 = new ByteLengthParser({
            length: 1
        });
        this.port2.pipe(this.parser2);
        handle_system_events.call(this, 2, this.parser2, this.port2, closecb2)
    } else
        this.port2 = null

    this.timer = setInterval(() => {
        send_next_tx.call(this)
    }, 100);   // ~5 bytes * 100us = 0.5ms

    // set the values for the queued commands to request
    this.req_bc_source = Number(opts.source);
    this.req_bc_volume = display_to_bc_volume(Number(opts.volume));
    this.req_bc_display = (opts.display)? MUTE.ON : MUTE.OFF;
    this.req_bc_mute = MUTE.OFF;

    // set initial properties of all devices
    this.set_source(1)
    this.set_source(2)
    this.set_volume(1)
    this.set_volume(2)
    this.set_display(1)
    this.set_display(2)
    this.set_mute(1)
    this.set_mute(2)
}

function handle_system_events(id, parser, port, closecb) {
    parser.on('data', data => {
        if (this.initializing) {
            this.initializing = false;
            this.emit('connected');
        }

        for(let i = 0; i < data.length; ++i) {
            let rx = parse_rx_byte(data[i], id)
            if(rx != null)
            {
                console.log("[BelCanto %d] rx packet", id, rx[PACKET_COMMAND_INDEX] & COMMAND_MASK, rx[PACKET_DATA0_INDEX],
                    (rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK)? (rx[PACKET_DATA0_INDEX]==ACK)? "ACK" : "NACK" : "")

                if((rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK) != TYPE_ACKNACK)
                {
                    let val = rx[PACKET_DATA0_INDEX]

                    switch(rx[PACKET_COMMAND_INDEX] & COMMAND_MASK) {
                    case COMMAND.Display:
                        let bool_display = (val == MUTE.ON)
                        console.log('[BelCanto %d] rx display: %s', id, val, bool_display);
                        if((rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK) == TYPE_ACKNACK) {
                            if(id == 1)
                                this.act_bc_display1 = this.req_bc_display
                            else
                                this.act_bc_display2 = this.req_bc_display
                        } else {
                            // the unit reported that the display mode was set, either because we set it or someone changed it
                            // if we set it then these values (act and req) will already be the reported value
                            this.req_bc_display = bool_display? MUTE.ON : MUTE.OFF
                            if(id == 1)
                                this.act_bc_display1 = this.req_bc_display
                            else
                                this.act_bc_display2 = this.req_bc_display
                        }
                        if((id == 1) && (this.act_bc_display2 != this.req_bc_display))
                            this.set_display(2)
                        else if((id == 2) && (this.act_bc_display1 != this.req_bc_display))
                            this.set_display(1)
                        break;
                    case COMMAND.Mute:
                        let display_mute = (val == MUTE.ON) ? "Muted" : "UnMuted"
                        let bool_mute = (val == MUTE.ON)
                        console.log('[BelCanto %d] rx mute: %s', id, val, display_mute);
                        this.properties.source = display_mute;
                        if((rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK) == TYPE_ACKNACK) {
                            if(id == 1)
                                this.act_bc_mute1 = this.req_bc_mute
                            else
                                this.act_bc_mute2 = this.req_bc_mute
                        } else {
                            this.req_bc_mute = val
                            if(id == 1)
                                this.act_bc_mute1 = this.req_bc_mute
                            else
                                this.act_bc_mute2 = this.req_bc_mute
                        }
                        if((id == 1) && (this.act_bc_mute2 != this.req_bc_mute))
                            this.set_mute(2)
                        else if((id == 2) && (this.act_bc_mute1 != this.req_bc_mute))
                            this.set_mute(1)
                        if(this.properties.mute != bool_mute)
                            this.emit('source', display_mute);
                        this.properties.mute = bool_mute
                        break;
                    case COMMAND.Input:
                        console.log('[BelCanto %d] rx source: %s', id, val);
                        this.properties.source = val;
                        if((rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK) == TYPE_ACKNACK) {
                            if(id == 1)
                                this.act_bc_source1 = this.req_bc_source
                            else
                                this.act_bc_source2 = this.req_bc_source
                        } else {
                            this.req_bc_source = val
                            if(id == 1)
                                this.act_bc_source1 = this.req_bc_source
                            else
                                this.act_bc_source2 = this.req_bc_source
                        }
                        if((id == 1) && (this.act_bc_source2 != this.req_bc_source))
                            this.set_source(2)
                        else if((id == 2) && (this.act_bc_source1 != this.req_bc_source))
                            this.set_source(1)
                        this.emit('source', val);
                        break;
                    case COMMAND.Volume:
                        let display_volume = bc_volume_to_display(val)
                        console.log('[BelCanto %d] rx volume: %d to %d', id,
                            (id == 1)?this.act_bc_volume1:this.act_bc_volume2, val, display_volume);
                        if((rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK) == TYPE_ACKNACK) {
                            if(id == 1)
                                this.act_bc_volume1 = this.req_bc_volume;
                            else
                                this.act_bc_volume2 = this.req_bc_volume;
                        } else {
                            this.req_bc_volume = val
                            if(id == 1)
                                this.act_bc_volume1 = this.req_bc_volume
                            else
                                this.act_bc_volume2 = this.req_bc_volume
                        }
                        if((id == 1) && (this.act_bc_volume2 != this.req_bc_volume))
                            this.set_volume(2)
                        else if((id == 2) && (this.act_bc_volume1 != this.req_bc_volume))
                            this.set_volume(1)
                        if(this.properties.volume != display_volume)
                            this.emit('volume', display_volume);
                        this.properties.volume = display_volume
                        break;
                    case COMMAND.Balance:
                        console.log('[BelCanto %d] rx ignored Balance', id);
                        break;
                    default:
                        console.log("[BelCanto %d] rx ignored unknown command", id, rx)
                        break;
                    }
                }
            }
        }
    });

    port.on('open', err => {
        this.emit('preconnected');
    });

    port.on('close', () => {
        port.close(() => {
            port = undefined;
            if (closecb) {
                var cb2 = closecb;
                closecb = undefined;
                cb2('close');
            }
        })
    });
    port.on('error', err => {
        port.close(() => {
            port = undefined;
            if (closecb) {
                var cb2 = closecb;
                closecb = undefined;
                cb2('error');
            }
        })
    });
    port.on('disconnect', () => {
        port.close(() => {
            port = undefined;
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

    let closecb1 = (why) => {
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
    let closecb2 = (why) => {
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

    if (this.port) {
        this.port.close(() => {
            this.init(opts, closecb1, closecb2);
        });
    } else {
        this.init(opts, closecb1, closecb2);
    }
};

BelCanto.prototype.stop = function () {
    this.seq++;
    if (this.port)
        this.port.close(() => {});
};

exports = module.exports = BelCanto;
