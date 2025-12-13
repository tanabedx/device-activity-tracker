<h1 align="center">Device Activity Tracker</h1>
<p align="center">WhatsApp Activity Tracker via RTT Analysis</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/React-18+-61DAFB?style=flat&logo=react&logoColor=black" alt="React"/>
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License MIT"/>
</p>

> ⚠️ **DISCLAIMER**: Proof-of-concept for educational and security research purposes only. Demonstrates privacy vulnerabilities in WhatsApp and Signal.

## Overview

This project implements the research from the paper **"Careless Whisper: Exploiting Silent Delivery Receipts to Monitor Users on Mobile Instant Messengers"** by Gabriel K. Gegenhuber, Maximilian Günther, Markus Maier, Aljosha Judmayer, Florian Holzbauer, Philipp É. Frenzel, and Johanna Ullrich (University of Vienna & SBA Research).

**What it does:** By measuring Round-Trip Time (RTT) of WhatsApp message delivery receipts, this tool can detect:
- When a user is actively using their device (low RTT)
- When the device is in standby/idle mode (higher RTT)
- Potential location changes (mobile data vs. WiFi)
- Activity patterns over time

**Security implications:** This demonstrates a significant privacy vulnerability in messaging apps that can be exploited for surveillance.

## Example

![WhatsApp Activity Tracker Interface](example.png)

The web interface shows real-time RTT measurements, device state detection, and activity patterns.

## Installation

```bash
# Clone repository
git clone https://github.com/gommzystudio/device-activity-tracker.git
cd device-activity-tracker

# Install dependencies
npm install
cd client && npm install && cd ..
```

**Requirements:** Node.js 20+, npm, WhatsApp account

## Usage

### Web Interface (Recommended)

```bash
# Terminal 1: Start backend
npm run start:server

# Terminal 2: Start frontend
npm run start:client
```

Open `http://localhost:3000`, scan QR code with WhatsApp, then enter phone number to track (e.g., `491701234567`).

### CLI Interface

```bash
npm start
```

Follow prompts to authenticate and enter target number.

## How It Works

The tracker sends reaction messages to non-existent message IDs, which triggers no notifications at the target. The time between sending the probe message and receiving the CLIENT ACK (Status 3) is measured as RTT.

### Statistical Analysis Model

The system uses a **two-dimensional statistical model** to classify device state:

#### Dimension 1: Activity State (RTT Magnitude)
- **Metric:** Window Median (μ) - median RTT over a sliding window of 20 samples
- **Classification:**
  - `Online` - RTT below adaptive threshold (device actively in use)
  - `Standby` - RTT above adaptive threshold (device idle/locked)
  - `Offline` - No response received (timeout)
  - `Calibrating` - Collecting initial samples

#### Dimension 2: Network Type (RTT Jitter)
- **Metric:** Window Jitter (σ) - Interquartile Range (IQR) of RTT in the window
- **Classification:**
  - `Wi-Fi` - Low jitter (stable connection)
  - `LTE` - High jitter (variable mobile connection)

#### Adaptive Thresholds

Thresholds are calculated dynamically using the **75th percentile (P75)** of historical measurements:

```
μ Threshold = P75 of historical median values
σ Threshold = P75 of historical jitter values
```

This allows the system to adapt to different network conditions and baseline RTT values.

#### Confidence System

The system uses a **three-tier confidence model** to prevent misclassification during early tracking:

| Confidence | Transitions Observed | Threshold Used |
|------------|---------------------|----------------|
| Low        | 0-1                 | Fixed (1000ms) |
| Medium     | 2-3                 | Adaptive P75   |
| High       | 4+                  | Adaptive P75   |

A **transition** is detected when the window median changes by more than 40% between consecutive windows.

#### State Confirmation

To prevent flickering between states, changes require **confirmation**:
- 3 consecutive window calculations in the new state
- Minimum 5 seconds persistence

Activity state and network type are confirmed **independently**.

#### Outlier Filtering

The frontend applies **conservative outlier filtering** to prevent Y-axis skewing:

1. **Threshold:** RTT must exceed **3x the median** AND be above **5000ms minimum**
2. **Isolation check:** Only isolated spikes (1-2 consecutive) are filtered; sustained high RTT (3+ consecutive) is kept as it indicates real network degradation
3. **Requires 20+ samples** before outlier detection activates

This ensures only truly extreme random spikes are filtered, not legitimate network events.

## Project Structure

```
device-activity-tracker/
├── src/
│   ├── tracker.ts      # Core RTT analysis logic
│   ├── server.ts       # Backend API server
│   └── index.ts        # CLI interface
├── client/             # React web interface
└── package.json
```

## How to Protect Yourself

The most effective protection is to enable "My Contacts" in WhatsApp under Settings → Privacy → Advanced. This prevents unknown numbers from sending you messages (including silent reactions). Disabling read receipts helps with regular messages but does not protect against this specific attack. As of December 2025, this vulnerability remains exploitable in WhatsApp and Signal.

## Ethical & Legal Considerations

⚠️ For research and educational purposes only. Never track people without explicit consent - this may violate privacy laws. Authentication data (`auth_info_baileys/`) is stored locally and must never be committed to version control.

## Citation

Based on research by Gegenhuber et al., University of Vienna & SBA Research:

```bibtex
@inproceedings{gegenhuber2024careless,
  title={Careless Whisper: Exploiting Silent Delivery Receipts to Monitor Users on Mobile Instant Messengers},
  author={Gegenhuber, Gabriel K. and G{\"u}nther, Maximilian and Maier, Markus and Judmayer, Aljosha and Holzbauer, Florian and Frenzel, Philipp {\'E}. and Ullrich, Johanna},
  year={2024},
  organization={University of Vienna, SBA Research}
}
```

## License

MIT License - See LICENSE file.

Built with [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)

---

**Use responsibly. This tool demonstrates real security vulnerabilities that affect millions of users.**

