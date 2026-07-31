# BLACK BOX — Hardware Roadmap

**Three product generations. One ecosystem.**

| Generation | Form | Role | Timeline | BOM | Retail |
|---|---|---|---|---|---|
| **v0** | Off-the-shelf BLE button | Trigger only — proves the system | Q3 2026 | $8–15 | $79–99 |
| **v1** | Custom **square cube** | Branded trigger — the BLACK BOX panic device | Q4 2026 – Q1 2027 | $25–35 | $129–179 |
| **v2** | Custom **round puck** | Full 360° Safety Recorder — the flagship | Q2–Q3 2027 | $120–200 | $349–499 |

All three pair with the same PWA. Each tier adds capability without breaking compatibility.

---

## v0 — Off-the-shelf BLE Button (Q3 2026)

**Purpose:** Validate the full activation → notification → dashboard loop with real hardware before committing capital to custom builds. Ships alongside Lite at MVP.

**Hardware:**
- Flic 2 BLE button (white-label or rebrand) — ~$35 retail single unit, ~$10–15 BOM at bulk
- Alternative: generic nRF52810 BLE button modules from Aliexpress ($5–10) with custom enclosure
- 3D-printed branded sleeve or wrap (PLA / nylon)
- Off-the-shelf coin cell battery (~12 month life)

**Capability:**
- Single-press → fires activation packet to paired phone
- Triple-press → cancel attempt (still requires hold confirm in PWA)
- That's it. Trigger only.

**Why ship this:**
- $0 design cost beyond branding
- Ships in 4–6 weeks
- Proves the loop with paying customers
- Cash flow funds v1 design
- Distinguishes Lite buyers from no-hardware Lite users in usage data

**Out:**
- Tamper detection (no sensors)
- Deadman release (just a button)
- 360° capture (none, it's a button)

---

## v1 — BLACK BOX Cube (Q4 2026 – Q1 2027)

**Purpose:** The first device that says "BLACK BOX" without explanation. Branded, designed, deniable. The trigger product for users who want hardware-grade reliability but not the full $399 recorder.

### Form & material

- **Shape:** Square cube, ~25×25×10mm
- **Material:** CNC-machined 7075-T6 hard-anodized aluminum (volume SKU) / Ti-6Al-4V Grade 5 (premium SKU)
- **Weight:** ~7g (Al) / ~17g (Ti)
- **Color:** Matte black (volume), gunmetal (Ti)
- **Wear:** Pendant chain, keychain ring, belt clip, or stand-alone in pocket

### Internals

| Component | Part | Notes |
|---|---|---|
| MCU + radio | Nordic nRF52840 (Raytac MDBT50Q module, FCC/CE/MIC certified) | Pre-certified saves $5K cert cost |
| IMU | ST LSM6DSO | Tap, shake, fall, orientation |
| Capacitive touch | TI FDC2114 or similar | "Squeeze to confirm" UX — optional, deferrable |
| Tamper | Mechanical switch + conductive mesh inner liner + photodiode | Three independent channels |
| Battery | 200–250mAh LiPo | 30+ days standby, hundreds of activations |
| Charging | USB-C (sealed, gasketed, IP65) OR Qi inductive (preferred, IP67/68) | Inductive is cleaner — recommend for v1 |
| Antenna | Chip antenna behind zirconia ceramic window | RF-transparent, durable |
| Beacon | IR LED + visible LED (recessed) | Helicopter / NVG / unaided eye locator |
| Last-gasp reserve | 33mF supercap | Final BLE burst on battery loss |

**BOM target (qty 1K):** $25–35

### Triggers (v1 specific)

| Trigger | Behavior |
|---|---|
| **Recessed tactile button** | Press to activate (3-sec hold to confirm prevents pocket-triggers) |
| **Triple-tap** | Stealth activation (no haptic feedback, looks like adjustment) |
| **Deadman release** | Pull-out pin variant — pin separates from body = immediate alert (no override). For high-threat scenarios. |
| **Shock threshold** | Impact >30g triggers alert (configurable) |
| **Tamper trigger** | Any tamper channel fires alert + last-gasp packet |
| **Capacitive squeeze** | Squeeze + hold = activate (optional, deferrable to v1.5) |

### Deadman release — the variant

A SKU variant where the cube has a pull-pin (like a grenade safety). The pin acts as a closing contact. Pull the pin → contact breaks → instant alert with no software intermediary. Cannot be cancelled from the device side. Only the PWA can stand it down via authenticated cancel within a 5-second grace window.

Marketing positioning: *"For the moments you can't reach for a button."*

### Connectivity

- **BLE 5.3** for phone pairing — encrypted, HMAC-authenticated handshake
- **No WiFi, no cellular** — keeps power budget tight, keeps cost down
- **Range:** ~30m line-of-sight to phone

### What v1 cannot do

- ❌ No camera (phone is the recorder)
- ❌ No microphone (phone is the recorder)
- ❌ No onboard storage
- ❌ No standalone cellular

Buyers who need those upgrade to v2.

### BOM detail (Al SKU, qty 1K)

| Item | Cost |
|---|---|
| 7075-T6 CNC shell + Type III anodize | $6–10 |
| Zirconia ceramic window | $1.50–3 |
| 4-layer PCB + flex tamper mesh | $1–2 |
| Raytac MDBT50Q module | $7–10 |
| LSM6DSO | $2.50–3.50 |
| Charging IC + Qi coil | $3.50–5.50 |
| 250mAh LiPo | $1.50–2.50 |
| Supercap | $1–2 |
| Tamper switch + photodiode | $0.60 |
| Misc passives | $1–2 |
| Potting (Shin-Etsu KE-1990) | $0.50–1 |
| Assembly + QC | $5–10 |
| **Total BOM** | **$31–52** |

Sells $129 = ~60% gross margin.

---

## v2 — BLACK BOX 360° Safety Recorder (Q2–Q3 2027)

**Purpose:** The flagship. The "literal black box" — its own recorder, its own storage, survives anything short of total physical destruction. For users whose threat model warrants it: journalists, DV survivors, solo travelers in unstable regions, parents of young adults, security professionals.

### Form & material

- **Shape:** Round puck, **40×40×15mm**, ~38g
- **Variants:**
  - **Puck (standard)** — 40×40×15mm, 38g
  - **Cylinder (clip)** — 55×35mm, 62g (more battery, more depth for sensors)
  - **Pendant (slim)** — 33×33×13mm, 28g (cleaner profile, less battery)
- **Material:** CNC aluminum 7075-T6 (volume) / Titanium Grade 5 (premium)
- **Colors:** Matte Black, Gunmetal Gray, Sandstone, Midnight Blue
- **Finish:** Hard anodize Type III + laser-etched brand mark

### Internals

| Component | Part | Notes |
|---|---|---|
| **Cameras** | Dual 180° fisheye (Sony IMX415 or IMX681 class) | Stitched to 4K equirectangular 360° |
| **Microphones** | 4-mic array, 24-bit, omnidirectional MEMS (Knowles SPH0645 or similar) | Beamforming, noise suppression, direction-of-arrival |
| **SoC** | Ambarella H22 or Rockchip RV1126 | Linux-based, dedicated video encode |
| **Memory** | 4GB LPDDR4 | Headroom for video pipeline |
| **Storage** | 64GB eMMC encrypted | Expandable to 128GB future SKU |
| **Connectivity** | WiFi Direct (5GHz, high-throughput) + BLE 5.3 + **optional LTE-M** | LTE-M = $40 add-on for cloud fallback |
| **GPS** | u-blox NEO-M9N | Multi-constellation, ~2m accuracy |
| **IMU** | Bosch BMI270 | Motion, orientation, fall, impact |
| **Battery** | 2000mAh Li-ion + supercap backup | 2–4 hours continuous recording, 5–10 days standby |
| **Charging** | USB-C fast charge (PD 18W) | 0–100% in ~90 min |
| **Tamper** | Mesh + switch + photodiode + temperature | Four channels, same architecture as v1 |
| **Status** | Single recessed LED (multi-color) | Power, recording, fault states |

**BOM target (qty 1K):** $120–200

### Technical specifications

| Spec | Value |
|---|---|
| Video | 360° (dual 180° fisheye) 4K equirectangular |
| Audio | 4-mic array, 24-bit, with noise suppression |
| Storage | 64GB eMMC (expandable in future) |
| Recording time | 2–4 hours continuous |
| Standby time | 5–10 days |
| Water/dust | IP67 / IP68 |
| Operating temp | -20°C to 60°C |
| Drop resistance | MIL-STD-810G (1.2m onto concrete) |

### How v2 works

```
ACTIVATE (one press, or auto-trigger via tamper/shock/deadman)
  ↓
RECORD on device SSD — full quality, encrypted
  ↓
STREAM to phone via WiFi Direct — high-throughput, low latency
  ↓
RELAY phone → cloud (R2) — downsampled real-time stream
  ↓
SHARE — instant live link to designated contacts
       — recipients can re-share, propagating exponentially
```

**Three copies, maximum survivability:**

- **PRIMARY:** On-device SSD. Full quality, encrypted. The flight recorder.
- **SECONDARY:** Cloud (R2). Downsampled stream. The shareable link.
- **TERTIARY:** Viewer cache. Optional local save. Every share creates another copy.

### Wear-it-your-way ecosystem

Same core device, multiple form-factor mounts (sold as accessories or bundled in Premium Kit):

- Men's necklace chain
- Women's necklace chain (different chain weight/length)
- Keychain clip
- Belt clip
- Sport mount (armband / chest strap)
- Wrist band (watch-style)
- Fashion pendant (decorative shell over the puck)

### Accessories ecosystem

| Accessory | Purpose | Retail |
|---|---|---|
| Magnetic charging dock | Branded Qi dock with status indicator | $29–39 |
| Sport mount | Chest strap / armband for active use | $19–29 |
| Lanyard | Wear options | $9–15 |
| Protective case | Travel / drop protection | $19–29 |
| Replacement chains / clips | Personalization | $9–25 |
| Extended battery sleeve | Doubles standby time | $49 (Phase 2) |

Recurring revenue lever: accessories. Same brand, attach rate of 1.5–2.5 accessories per device sale is realistic.

### Operating modes

| Mode | What it does |
|---|---|
| **Standby** | Listening for BLE trigger, all sensors low-power, 5–10 day battery |
| **Armed** | Active monitoring, periodic self-checks, BLE heartbeat to phone |
| **Recording** | Full 360° capture, audio, location streaming, dashboard live |
| **Beacon** | Post-event location aid — IR + visible LED pulsing, audio tone, GPS broadcast |
| **Forensic** | Device retrieved post-event, encrypted SSD readable only via authenticated factory tool |
| **Self-destruct** | (Optional firmware variant) Detected tamper at high threat level wipes consumer-accessible data but preserves audit ledger |

---

## Cross-generational design principles

**1. One pairing protocol across all generations**
The PWA pairs the same way to a v0 Flic button, a v1 cube, or a v2 puck. BLE GATT service UUIDs and HMAC handshake are identical. Upgrading hardware doesn't require re-onboarding.

**2. Tamper-as-trigger across all custom generations**
v1 and v2 both fire alerts on tamper. v0 cannot (no sensors). This is the spec'd patent angle and the brand's structural promise.

**3. Last-gasp on custom generations**
v1 and v2 both have supercap reserves and brownout-triggered final packets. v0 does not.

**4. No subscriptions, ever**
All capability is included one-time. Server-side infrastructure cost is absorbed by Anthropic-style "use our free tiers until paid scale, then we already have margin" pricing.

---

## Supply chain summary by generation

| Component | v0 source | v1 source | v2 source |
|---|---|---|---|
| MCU / SoC | Flic 2 BOM included | Raytac MDBT50Q | Ambarella / Rockchip |
| Enclosure | 3D-print sleeve | JLCCNC → Shenzhen scale | JLCCNC prototype → Foster/PCH scale |
| Ceramic window | N/A | Kyocera (Japan) | Kyocera (Japan) |
| Cameras | N/A | N/A | Sony IMX series |
| Mics | N/A | N/A | Knowles MEMS |
| Battery | Coin cell (off-the-shelf) | PKCELL LiPo | Panasonic Li-ion |
| Potting | N/A | Shin-Etsu KE-1990 | Shin-Etsu KE-1990 |
| Manufacturing | Direct from Flic | Shenzhen via Dragon/PCH | Japan precision shop (Ti) + Shenzhen (Al) |

Full sourcing details in `BLACKBOX_SUPPLY_CHAIN.md`.

---

## Certifications budget by generation

| Cert | v0 (uses Flic certs) | v1 (Raytac module certs) | v2 (custom radio modules) |
|---|---|---|---|
| FCC | included | included | $5–10K |
| CE | included | included | $4–8K |
| MIC (Japan) | included | included | $3–5K |
| IC (Canada) | included | included | $2–4K |
| IP67/68 | N/A | $2–5K | $2–5K |
| UN38.3 (battery) | N/A | $2–4K | $2–4K |
| MIL-STD-810G drop | N/A | $2–5K | $2–5K |
| **Total** | **$0** | **$6–14K** | **$20–41K** |

v0 ships under existing certifications. v1 needs IP/drop/battery testing. v2 needs full radio cert because of WiFi + optional LTE-M.

---

## Roadmap dependencies

```
                                   ┌───────────────────────────────┐
                                   │ Lite PWA built & shipping Q3  │
                                   │ Revenue + activation data     │
                                   └──────────────┬────────────────┘
                                                  │
                       ┌──────────────────────────┼─────────────────────┐
                       │                          │                     │
                       ▼                          ▼                     ▼
            ┌──────────────────┐     ┌──────────────────┐    ┌──────────────────┐
            │ v0 Flic launch   │     │ v1 cube design   │    │ v2 puck design   │
            │ Q3 2026          │     │ starts Q3 2026   │    │ starts Q4 2026   │
            │ 4-6 weeks        │     │ ships Q4–Q1      │    │ ships Q2–Q3 2027 │
            └──────────────────┘     └──────────────────┘    └──────────────────┘
                       │                          │                     │
                       └──────────────────────────┼─────────────────────┘
                                                  ▼
                                       Year 2: V2 Pro (Ti, LTE-M std),
                                       extended battery, premium tier
```

---

## Open decisions

1. **Branding language across tiers.** Do all three say "BLACK BOX" on the device, or do we name them distinctly (e.g., "BLACK BOX Sentinel" = v1 cube, "BLACK BOX Recorder" = v2 puck)? My recommendation: distinct names. Easier to differentiate in marketing.
2. **v1 deadman variant as separate SKU or option?** Recommend separate SKU at $20 premium. Different inventory, different positioning.
3. **v2 LTE-M as standard or option?** Recommend option at $40 premium for v2 base, standard on v2 Pro.
4. **Manufacturing partner choice for v1.** Decision needed by mid-2026: Dragon Innovation, PCH, or HAX accelerator placement.

---

**End of hardware roadmap. Supply chain detail: `BLACKBOX_SUPPLY_CHAIN.md`.**
