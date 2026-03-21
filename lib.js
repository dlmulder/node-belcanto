"use strict";

const {SerialPort} = require("serialport");
const {ByteLengthParser} = require('@serialport/parser-byte-length');
let util = require("util"),
events = require('events');

const rx_bytes1 = [];
const rx_bytes2 = [];
const rx_packets1 = [];
const rx_packets2 = [];

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
}

util.inherits(BelCanto, events.EventEmitter);


//
// Bel Canto RS232 API
//

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
    Display:2, Mute:3, Input:5, Volume:7, Media:8, Balance:9, AckRxWrite:100, NackRxWrite:101
}

// subsequent bytes are Data
const PACKET_DATA0_INDEX = 2

// final byte is Checksum (Type + Command + Data[]) Mod 256 (<before> DLE suppression)

const MUTE = {
    OFF:0xe0, ON:0xe1, SOFT:0xe2    // also display ON/OFF
}
const MEDIA = {
    PlayPause:13, Prev:25, Next:26
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
}
BelCanto.prototype.request_mute = function(mute) {
    this.req_bc_mute = mute? MUTE.ON : MUTE.OFF
}
BelCanto.prototype.request_source = function(source) {
    this.req_bc_source = Number(source)
}
BelCanto.prototype.request_display = function(display) {
    this.req_bc_display = display? MUTE.ON : MUTE.OFF
}

BelCanto.prototype.volume_up = function (id=null) {
    this.req_bc_volume = display_to_bc_volume(this.volume + 1)
};
BelCanto.prototype.volume_down = function (id=null) {
    this.req_bc_volume = display_to_bc_volume(this.volume - 1)
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
    this.rx_data1 = []
    handle_system_events.call(this, rx_bytes1, this.parser1, this.port1, closecb1)

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
        this.rx_data2 = []
        handle_system_events.call(this, rx_bytes2, this.parser2, this.port2, closecb2)
    } else
        this.port2 = null

    // set the values for the queued commands to request
    this.act_bc_volume1 = -1;
    this.act_bc_volume2 = -1;
    this.req_bc_source = Number(opts.source);
    this.req_bc_volume = display_to_bc_volume(Number(opts.volume));
    this.req_bc_display = (opts.display)? MUTE.ON : MUTE.OFF;
    this.req_bc_mute = MUTE.OFF;

    this.rx_packet1 = [];
    this.rx_packet2 = [];
    this.next_tx_state = 0;
    handle_timers.call(this)
}

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


//
// handlers
//

function handle_system_events(rx_bytes, parser, port, closecb) {
    parser.on('data', data => {
        rx_bytes.push(...data)
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

function handle_timers() {
    // timer tasks to parse the incoming bytes into packets, to handle those packets, and to send queued tx packets
    const rx_bytes_timer1 = setInterval(() => {
        if(rx_bytes1.length > 0) {
            for(let i = 0; i < rx_bytes1.length; ++i) {
                let b = rx_bytes1[i]
            let p = parse_rx_byte(b, 1, this.rx_packet1)
            if(p != null) {
                rx_packets1.push(Array.from(p))
                this.rx_packet1.length = 0
                }
            }
            rx_bytes1.length = 0
        }
    }, 2)

    const rx_bytes_timer2 = setInterval(() => {
        if(rx_bytes2.length > 0) {
            for(let i = 0; i < rx_bytes2.length; ++i) {
                let b = rx_bytes2[i]
                let p = parse_rx_byte(b, 2, this.rx_packet2)
                if(p != null) {
                    rx_packets2.push(Array.from(p))
                    this.rx_packet2.length = 0
                    p = null
                }
            }
            rx_bytes2.length = 0
        }
    }, 2)

    const rx_packets_timer1 = setInterval(() => {
        if(rx_packets1.length > 0) {
            for(let i = 0; i < rx_packets1.length; ++i) {
                let p = rx_packets1[i]
                handle_rx_packet.call(this, p, 1)
            }
            rx_packets1.length = 0
        }

        if (this.initializing) {
            this.initializing = false;
            this.emit('connected');
        }
    }, 25);

    const rx_packets_timer2 = setInterval(() => {
        if(rx_packets2.length > 0) {
            for(let i = 0; i < rx_packets2.length; ++i) {
                let p = rx_packets2[i]
                handle_rx_packet.call(this, p, 2)
            }
            rx_packets2.length = 0
        }
    }, 25);

    const update_all_timer = setInterval(() => {
        update_all.call(this)
    }, 42)
}


//
// RX
//

// the most recent received data
const RX_PACKET_STATE = { rx_idle:0, rx_type:1, rx_command:2, rx_data:3, rx_data_dle:4, rx_checksum:5, rx_checksum_dle:6 }
let rx_packet_checksum = 0
let rx_packet_state = RX_PACKET_STATE.rx_idle
let rx_packet_datalen = 0

function parse_rx_byte(b, id, rx_packet)
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
        if(((b & COMMAND_MSB) == COMMAND_MSB) || ((rx_packet[PACKET_TYPE_INDEX] & TYPE_ACKNACK) == TYPE_ACKNACK)) {
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
        rx_packet_checksum %= 256
        if(corrected_b == rx_packet_checksum)
            result = rx_packet
        else
            rx_packet_state = RX_PACKET_STATE.rx_idle
        break;
    }

    if(error_string)
        console.log("parse_rx_byte error:", error_string, rx_packet)

    return result    // null if not done with a full and correct packet
}

function handle_rx_packet(rx, id) {
    let is_acknack = (rx[PACKET_TYPE_INDEX] & TYPE_ACKNACK) != 0
    let is_ack = is_acknack && (rx[PACKET_DATA0_INDEX]==ACK)
    let is_nack = is_acknack && (rx[PACKET_DATA0_INDEX]==NACK)
    let is_report = ! is_acknack

    if(is_nack)
        console.log("handle_rx_packet%d got NACK", id, rx[PACKET_COMMAND_INDEX] & COMMAND_MASK, rx[PACKET_DATA0_INDEX])

    let val = rx[PACKET_DATA0_INDEX]    // NOTE: val is not valid when ACK/NACK

    // the unit reported that a setting changed, either
    // 1. someone changed it with an IR remote control or similar
    //      in this case simply set the requested value, and that will cause an update to the other unit
    // 2. an ACK is reported in reponse to this extension changing it
    //      in this case we now know the unit is at the requested value
    // 2. a NACK is reported when the unit can't change to the requested value
    //      in this case the requested value will be changed back to the previous actual
    switch(rx[PACKET_COMMAND_INDEX] & COMMAND_MASK) {
    case COMMAND.Display:
        if(is_report) {
            this.req_bc_display = (val == MUTE.ON)? MUTE.ON : MUTE.OFF
            console.log('[BelCanto %d] user changed display: %s', id, val);
        }
        if(is_ack || is_report) {
            if(id == 1) this.act_bc_display1 = this.req_bc_display
            else        this.act_bc_display2 = this.req_bc_display
        }
        if(is_nack) {
            if(id == 1)this.req_bc_display = this.act_bc_display1
            else       this.req_bc_display = this.act_bc_display2
        }
        break;
    case COMMAND.Mute:
        if(is_report) {
            this.req_bc_mute = val
            console.log('[BelCanto %d] rx mute: %s', id, val, (val == MUTE.ON) ? "Muted" : "UnMuted");
        }
        if(is_ack || is_report) {
            if(id == 1) this.act_bc_mute1 = this.req_bc_mute
            else        this.act_bc_mute2 = this.req_bc_mute

            let display_mute = (val == MUTE.ON) ? "Muted" : "UnMuted"
            this.properties.source = display_mute;
            this.emit('source', display_mute);
        }
        if(is_nack) {
            if(id == 1) this.req_bc_mute = this.act_bc_mute1
            else        this.req_bc_mute = this.act_bc_mute2
        }
        break;
    case COMMAND.Input:
        if(is_report) {
            this.req_bc_source = val
            console.log('[BelCanto %d] rx source: %s', id, val);
            this.properties.source = val;
            this.emit('source', val);
        }
        if(is_ack || is_report) {
            if(id == 1) this.act_bc_source1 = this.req_bc_source
            else        this.act_bc_source2 = this.req_bc_source
            if(is_ack) console.log('source ACK', id, this.act_bc_source1, this.act_bc_source2, this.req_bc_source);
        }
        if(is_nack) {
            if(id == 1) this.req_bc_source = this.act_bc_source1
            else        this.req_bc_source = this.act_bc_source2
        }
        break;
    case COMMAND.Volume:
        if(is_report) {
            this.req_bc_volume = val
            console.log('[BelCanto %d] rx volume: %d to %d', id,
                (id == 1)?this.act_bc_volume1:this.act_bc_volume2, val, bc_volume_to_display(val),
                (id == 1)?this.port1.path:this.port2.path);
        }
        if(is_ack || is_report) {
            if(id == 1) this.act_bc_volume1 = this.req_bc_volume;
            else        this.act_bc_volume2 = this.req_bc_volume;

            let display_volume = bc_volume_to_display(this.req_bc_volume)
            this.properties.volume = display_volume
            this.emit('volume', display_volume);
        }
        if(is_nack) {
            if(id == 1) this.req_bc_volume = this.act_bc_volume1
            else        this.req_bc_volume = this.act_bc_volume2
        }
        break;
    case COMMAND.Media:
        if(is_report) {
            console.log("[BelCanto %d] media", id, val)
            if(val == MEDIA.Next)
                this.emit('next_pressed')
            else if(val == MEDIA.Prev)
                this.emit('prev_pressed')
            else if(val == MEDIA.PlayPause)
                this.emit('play_pause_pressed')
        }
        break;
    case COMMAND.Balance:
        console.log('[BelCanto %d] rx ignored Balance', id);
        break;
    default:
        console.log("[BelCanto %d] rx ignored unknown command", id, rx)
        break;
    }
}

//
// TX
//

function writeToPort(port, data) {
    port.write(data)
    console.log("write", data)
}

function make_tx_command(command, data, read_not_write=false) {
    if((command == COMMAND.AckRxWrite) || (command == COMMAND.NackRxWrite))
        return
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

function update_all() {
    let q = []  // notifications that need to be sent
    if(this.act_bc_volume1 != this.req_bc_volume) q.push(0);
    if(this.act_bc_volume2 != this.req_bc_volume) q.push(1);
    if(this.act_bc_source1 != this.req_bc_source) q.push(2);
    if(this.act_bc_source2 != this.req_bc_source) q.push(3);
    if(this.act_bc_display1 != this.req_bc_display) q.push(4);
    if(this.act_bc_display2 != this.req_bc_display) q.push(5);
    if(this.act_bc_mute1 != this.req_bc_mute) q.push(6);
    if(this.act_bc_mute2 != this.req_bc_mute) q.push(7);

    // write one tx packet per call, to limit serial port traffic
    if(q.length > 0) {
        let next = null
        while(next == null) {
            next = q[this.next_tx_state]
            //console.log("loop", this.next_tx_state, next, q)
            ++this.next_tx_state
            if(this.next_tx_state > 7)
                this.next_tx_state = 0
            if(next != null)
                break;
        }

        console.log("q", q)
        if(next != null) {
            switch(next) {
                case 0: { let s = make_tx_command(COMMAND.Volume, this.req_bc_volume); writeToPort(this.port1, s); break; }
                case 1: { let s = make_tx_command(COMMAND.Volume, this.req_bc_volume); writeToPort(this.port2, s); break; }
                case 2: { let s = make_tx_command(COMMAND.Input, this.req_bc_source); writeToPort(this.port1, s); break; }
                case 3: { let s = make_tx_command(COMMAND.Input, this.req_bc_source); writeToPort(this.port2, s); break; }
                case 4: { let s = make_tx_command(COMMAND.Display, this.req_bc_display); writeToPort(this.port1, s); break; }
                case 5: { let s = make_tx_command(COMMAND.Display, this.req_bc_display); writeToPort(this.port2, s); break; }
                case 6: { let s = make_tx_command(COMMAND.Mute, this.req_bc_mute); writeToPort(this.port1, s); break; }
                case 7: { let s = make_tx_command(COMMAND.Mute, this.req_bc_mute); writeToPort(this.port2, s); break; }
            }
        }
    }
}

exports = module.exports = BelCanto;
