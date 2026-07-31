# BLACK BOX — Hardware Supply Chain & Sourcing

**Status:** Sourcing reference for prototype + small-batch production
**Target:** v0 prototype (1–10 units) → v1 small batch (100 units) → v1 production (1,000–10,000 units)

---

## 0. Locked hardware spec (reference)

- **Shell:** 7075-T6 hard-anodized aluminum (volume) / Ti-6Al-4V Grade 5 (premium)
- **Antenna window:** Zirconia or alumina ceramic insert (~12mm)
- **Charging:** Qi inductive, no external port
- **Sealing:** Sylgard 184 silicone gel potting, factory-serviceable
- **Tamper:** 4-channel (mechanical switch + conductive mesh + photodiode + IMU shock)
- **Last-gasp:** 33mF supercapacitor reserve + brownout-triggered final BLE burst
- **MCU:** Nordic nRF52840 (pre-certified module preferred)
- **IMU:** ST LSM6DSO
- **Battery:** 250mAh LiPo
- **Form factors:** Pendant (25×25×10mm), Keychain (35×22×8mm), Clip (40×25×10mm)

---

## 1. Critical components — recommended suppliers

### nRF52840 module (pre-certified preferred)

Saves $5–15K of FCC/CE certification cost by using already-certified modules.

| Supplier | Module | Notes | Qty 1K price |
|---|---|---|---|
| **Raytac** | MDBT50Q-1MV2 | FCC, CE, IC, MIC certified. Industry standard. | $7–10 |
| **Fanstel** | BT840F | FCC, CE, IC. Slightly smaller. | $8–12 |
| **u-blox** | NORA-B106 | Premium, excellent docs, multi-cert. | $12–18 |
| **Insight SiP** | ISP1907 | Ultra-small SiP. | $10–15 |

**Recommendation:** Start with Raytac MDBT50Q. Best supported, most common, easiest to find dev boards.

**Contact:** https://www.raytac.com/ — Taiwanese, English-speaking sales, responsive.

---

### IMU (accelerometer + gyro)

| Supplier | Part | Notes | Qty 1K |
|---|---|---|---|
| **ST Microelectronics** | LSM6DSO | 6-axis, low power, tap detection, shock detection | $2.50–3.50 |
| **Bosch** | BMI270 | Alternative, slightly lower power | $3–4 |

**Recommendation:** LSM6DSO. Mature, well-documented, in-stock globally.

**Source via:** Digi-Key, Mouser, Arrow.

---

### Qi inductive charging IC

| Supplier | Part | Notes | Qty 1K |
|---|---|---|---|
| **Texas Instruments** | BQ51013B | 5W Qi receiver, well-supported | $2–3 |
| **Renesas (IDT)** | P9221-R | Alternative, slightly newer | $2–3 |
| **NXP** | MWPR1516 | Premium option | $3–4 |

**Coil supplier:**
- **Würth Elektronik** — 760308101 (18mm coil with ferrite shield) — $1.50–2.50 qty 1K
- **TDK** — WT505090-15F2-A — similar specs
- **Vishay** — IWAS-3827EC — alternative

**Recommendation:** BQ51013B + Würth 760308101.

---

### Battery (LiPo)

Standard form factors widely available.

| Supplier | Type | Notes | Qty 1K |
|---|---|---|---|
| **PKCELL** | LP501230 (250mAh, 5×12×30mm) | Reliable, low cost | $1.50–2.50 |
| **Panasonic** | UF553436G (300mAh) | Japan-based, premium quality | $3–5 |
| **EEMB** | LP301030 | Compact alternative | $2–3 |
| **Custom pack** | Inventus Power | Custom shape, custom protection | $8–15 (MOQ ~5K) |

**Recommendation:**
- v0 / v1 small batch: PKCELL via Alibaba or Mouser
- v1 production: Panasonic (Japan-sourced, sells the "Made with Japanese cells" story for the Ti SKU)
- v2 custom shape: Inventus Power

**Critical note:** All cells need **UN38.3 certification** for air transport. Most quality suppliers provide. Verify before ordering.

---

### Supercapacitor (last-gasp reserve)

| Supplier | Part | Notes | Qty 1K |
|---|---|---|---|
| **AVX/Kyocera** | SCMR18C474PRBA0 (470mF) | Premium, Kyoto-based | $1.50–2.50 |
| **Eaton** | HV1030-2R7474-R | Industrial grade | $1–2 |
| **Würth Elektronik** | 480E series | Reliable mid-range | $1–2 |

**Recommendation:** Eaton HV1030 for v0, AVX/Kyocera for production (Japan supply chain story).

---

### Ceramic antenna window

| Supplier | Material | Notes |
|---|---|---|
| **Kyocera Fine Ceramics** (Japan, Kyoto) | Zirconia or alumina | Premium. Kyocera is global leader. Strong fit for "Japan-engineered" story. |
| **Tosoh Corporation** (Japan) | Zirconia (YSZ) | High-quality zirconia specialist. Tokyo-based. |
| **CoorsTek** (US) | Alumina, zirconia | US-based, broad catalog |
| **CeramTec** (Germany) | Industrial ceramics | European supplier |

**Recommendation:** Kyocera. You're in Okinawa — same country, supply chain story, world-class quality. MOQ may be higher (5K+ units typical for custom-cut parts). For prototyping, order from CeramTec or via stock catalog (Ortech Ceramics in US has small-batch).

**Cut and finish:** Need 12mm diameter × 1–1.5mm thickness disc, polished one side, optionally laser-etched with brand mark.

**Contact (Japan):**
- Kyocera Fine Ceramics: https://global.kyocera.com/prdct/fc/ — has English-speaking technical sales
- Tosoh: https://www.tosoh.com/ — zirconia specialist

---

### Aluminum shell (CNC machined, 7075-T6)

#### Prototype (1–50 units)
| Supplier | Country | Lead time | Per-unit cost |
|---|---|---|---|
| **JLCCNC** (JLCPCB sister) | China | 5–10 days | $5–25 |
| **PCBWay CNC** | China | 7–14 days | $8–35 |
| **Xometry** | US/global | 5–14 days | $40–150 |
| **Protolabs** | US/global | 1–7 days | $60–200 |
| **Hubs** (Protolabs) | US/global | 5–14 days | $30–120 |

**Recommendation for prototyping:** JLCCNC for cost, Xometry/Hubs for US/Japan-shipped quality.

#### Volume (100–10,000 units)
| Supplier | Country | MOQ | Per-unit cost |
|---|---|---|---|
| **Dragon Innovation** | China (US-managed) | 500+ | $8–18 |
| **Shenzhen-based CNC partners via PCH** | China | 500+ | $6–14 |
| **JLCCNC** | China | 100+ | $4–12 |
| **Local Japan machining shop** | Japan | 50+ | $25–60 |

**Recommendation:** For volume Al SKU, JLCCNC up to 1K, then transition to dedicated Shenzhen partner via PCH International or Dragon Innovation.

---

### Titanium shell (CNC machined, Ti-6Al-4V Grade 5)

Harder to machine, more expensive, longer lead times.

| Supplier | Country | Notes | Per-unit |
|---|---|---|---|
| **Xometry** | US | Quote-based, good for prototype | $80–250 (qty 50) |
| **Protolabs** | US | Premium, fast | $120–300 (qty 50) |
| **Shenzhen Sutoukenban** | China | Volume Ti machining | $30–80 (qty 1K) |
| **Komaspec** | China | High-quality CNC including Ti | $40–100 (qty 500) |
| **Local Japan precision shop** | Japan | "Made in Japan" story | $80–200 (qty 500) |

**Recommendation:** For Ti SKU, dedicated Japan precision shop. Premium price supports premium positioning. Look in Tokyo/Osaka industrial directories or contact Tama Tech, JTEKT subsidiary, or use Mitsubishi Materials network.

---

### Anodizing (Type III hard anodize)

| Service | Country | Notes |
|---|---|---|
| **Pioneer Metal Finishing** | US | Type III hard anodize, milspec certified |
| **Tiodize** | US | Premium hard anodize specialist |
| **Bulk via CNC partner** | China | Most Chinese CNC shops offer integrated anodizing — verify Type III specifically |
| **Local Okinawa/Japan finishing** | Japan | Search "ハードアルマイト" (hard anodize) in industrial directories |

**Recommendation:** Integrated with CNC supplier. JLCCNC offers Type II — verify Type III separately. For Japan-made premium SKU, source dedicated finishing shop.

---

### PCB design + manufacture + assembly

| Service | Country | Notes |
|---|---|---|
| **JLCPCB + JLCSMT** | China | Integrated PCB + SMT assembly, very low cost. $50–200 for 5 prototype boards assembled. |
| **PCBWay** | China | Similar, slightly higher quality |
| **Seeed Fusion** | China | Integrated services including BOM sourcing |
| **Sierra Circuits** | US | High-quality, FCC-compliant fab |
| **Eurocircuits** | EU | European option |

**Recommendation:** JLCPCB + JLCSMT for prototype and small batch. Sierra Circuits for production if US compliance becomes critical.

**BOM sourcing:** LCSC (JLC's parts arm) has 1.5M+ parts. For non-stocked parts, also use Digi-Key or Mouser.

---

### Potting compound

| Supplier | Product | Notes |
|---|---|---|
| **Dow** | Sylgard 184 | Standard reference, removable with heat |
| **Shin-Etsu** (Japan) | KE-1990 series | Japanese alternative, similar specs |
| **Wacker** (Germany) | Elastosil RT 622 | European alternative |
| **Momentive** | TSE3032 | Industrial alternative |

**Recommendation:** Shin-Etsu KE-1990 — Japan-based, easy to source locally for you, comparable performance to Sylgard.

**Contact:** https://www.shinetsusilicone-global.com/

---

### Conductive mesh (tamper detection)

This is a custom flex PCB design. Order alongside main PCB.

| Supplier | Notes |
|---|---|
| **JLCPCB Flex** | Flex PCB service, can do simple mesh patterns, low cost |
| **PCBWay Flex** | Similar |
| **All Flex** (US) | Premium flex PCB |

**Recommendation:** Co-design with main PCB at JLCPCB.

---

### Tamper switch + photodiode

Standard components.

| Component | Supplier | Part |
|---|---|---|
| Spring-loaded tamper switch | Panasonic | EVQQ2 series detector switch |
| Photodiode (visible spectrum) | Vishay | TEMD5510 |
| LED indicator | Cree, Kingbright | Standard 0603 SMD |

Source via Digi-Key, Mouser, or LCSC.

---

### Charging dock (accessory)

| Approach | Cost |
|---|---|
| White-label commodity Qi pad | $4–8 per unit (qty 1K via Alibaba) |
| Custom dock design (alignment well, magnet) | $12–25 (qty 1K) |
| Premium dock with status LED | $20–35 (qty 1K) |

**Recommendation:** v0 — white-label commodity. v1+ — custom-designed dock matching device aesthetic.

**Custom design partner:** Same CNC supplier as device shell. Same finishes.

---

## 2. Full BOM estimate (volume Al SKU, qty 1,000)

| Category | Item | Cost |
|---|---|---|
| Shell | 7075-T6 CNC + Type III anodize | $6–10 |
| Ceramic window | Alumina insert cut + bond | $1.50–3 |
| PCB | 4-layer FR4 + flex tamper mesh | $1–2 |
| MCU module | Raytac MDBT50Q-1MV2 | $7–10 |
| IMU | LSM6DSO | $2.50–3.50 |
| Charging IC | BQ51013B | $2–3 |
| Charging coil | Würth 760308101 | $1.50–2.50 |
| Battery | PKCELL 250mAh LiPo | $1.50–2.50 |
| Supercap | Eaton HV1030 | $1–2 |
| Tamper switch | Panasonic EVQQ2 | $0.30 |
| Photodiode | Vishay TEMD5510 | $0.30 |
| Misc passives + connectors | — | $1–2 |
| Potting | Shin-Etsu KE-1990 | $0.50–1 |
| Assembly + QC | EMS partner | $5–10 |
| **Total BOM** | | **$31–52** |

Selling at $99 = ~50% gross margin. Healthy.

For Ti SKU: add $15–25 to BOM (titanium machining), sell at $249 = ~70% margin.

---

## 3. Recommended prototype path (cheapest to validation)

### Step 1: Breadboard (week 1)
- Nordic nRF52840 dev kit ($50) + LSM6DSO breakout ($15) + LiPo charger module ($10)
- Write firmware, validate concept
- **Total: ~$100**

### Step 2: First custom PCB + off-the-shelf enclosure (week 3–4)
- JLCPCB design + assembly: ~$200 for 5 boards
- Off-the-shelf project box for housing
- Validate electronics work
- **Total: ~$300**

### Step 3: Custom CNC prototype (week 6–8)
- JLCCNC 10 Al shells: ~$150
- Ortech ceramic discs (small batch): ~$80
- Hand-assemble with Sylgard potting kit ($40)
- **Total: ~$400**

### Step 4: Small batch beta (month 3–4)
- 50–100 units, fully assembled, real packaging
- Recommended: PCH International or Dragon Innovation as project manager
- Budget: $8K–15K all-in for 100 units (BOM + machining + assembly + freight)

### Step 5: Production run (month 6+)
- 1,000 units minimum for COGS to hit projected numbers
- Budget: $30K–55K all-in
- Lead time: 8–12 weeks from PO

---

## 4. Manufacturing partners (full-service)

For "I want to give one company my spec and have them deliver finished units":

| Partner | Strengths | Stage fit |
|---|---|---|
| **PCH International** | Wearables/IoT specialist, Cork+Shenzhen, English support | 500+ units |
| **Dragon Innovation** | Founded by ex-iRobot, hardware specialist, US-managed | 1K+ units |
| **Synapse Product Development** | High-end product dev + manufacturing | Premium products |
| **Bolt** (no longer active in this form — verify status) | Was a hardware accelerator + sourcing | — |
| **Lab IX** | Flex's startup arm | Series A+ stage |
| **HAX** (SOSV) | Hardware accelerator with sourcing connections | Pre-seed |

**Recommendation:** Reach out to **HAX** (if open to accelerator) or **PCH International** (if going direct). Both will manage the multi-supplier orchestration so you don't have to.

**For Japan-domestic manufacturing of Ti SKU:**
- **TechShop Japan** (closed; verify alternatives)
- **DMM.make AKIBA** — Tokyo-based hardware accelerator with manufacturing connections
- **Direct outreach to** Tokyo/Osaka small precision shops via local industrial associations
- **Foster Electric** — Japan-based EMS with consumer electronics history
- **Funai Electric** — Japan EMS

---

## 5. Certifications budget

Required to legally sell in each market.

| Cert | Market | Cost | Lead time |
|---|---|---|---|
| FCC Part 15 + 15.247 | US | $5–10K | 6–10 weeks |
| CE (RED) | EU | $4–8K | 8–12 weeks |
| ISED | Canada | $2–4K | 6–8 weeks |
| MIC (TELEC) | Japan | $3–5K | 8–12 weeks |
| RCM | Australia | $1–3K | 4–6 weeks |
| KC | South Korea | $2–4K | 8–10 weeks |
| UN38.3 (battery) | Global (air freight) | $2–4K | 4–6 weeks |
| IP67/68 test | Marketing claim | $2–5K | 2–4 weeks |
| MIL-STD-810G drop | Marketing claim | $2–5K | 4–6 weeks |

**MVP launch markets recommended:**
- US + Japan: ~$15–25K cert budget
- Add EU: +$4–8K
- Use **pre-certified modules** (Raytac MDBT50Q) to skip module-level radio cert. Saves ~$5K.

**Certification labs:**
- **UL** — global, top tier
- **TÜV Rheinland** — global, strong in EU/Japan
- **Bureau Veritas** — global
- **Element Materials Technology** — US/UK, fast turnaround
- **DEKRA** — EU specialist
- **VS&C** (Japan) — local Japan cert

---

## 6. Outreach template for supplier inquiries

### For component suppliers:

> Subject: BLE wearable safety device — quote request for [component]
>
> Hi [Supplier],
>
> I'm developing a wearable personal safety device (BLE 5.x, IP67, custom enclosure) targeting Q[X] 2026 launch. Targeting 1,000 unit first production run, scaling to 10,000+ in year one.
>
> I need a quote for:
> - [Component, part number, quantity]
> - Lead time
> - MOQ
> - Sample availability for prototype (quantity X)
>
> Form factor: [dimensions]
> Operating temperature: -10°C to 60°C
> Certification needs: FCC, CE, MIC
>
> Can you also provide a reference design or evaluation board if available?
>
> Thanks,
> [Name]

### For manufacturing partners (PCH, Dragon, HAX):

> Subject: Wearable BLE safety device — manufacturing partner inquiry
>
> Hi [Partner],
>
> I'm developing BLACK BOX, a wearable personal safety device combining a CNC-machined aluminum/titanium enclosure, nRF52840 module, inductive charging, and tamper detection. Software is a PWA with BYOK AI architecture.
>
> Looking for a manufacturing partner who can help with:
> - DFM review on current spec
> - Component sourcing
> - PCB assembly
> - Final assembly and QC
> - Certification coordination (US, Japan minimum)
>
> Initial production: 1,000 units. Year-one target: 10,000+.
>
> Spec sheet attached. Can we schedule a 30-minute intro call?
>
> Best,
> [Name]

---

## 7. Action items (in order)

1. **Order Nordic nRF52840 DK** + LSM6DSO breakout + LiPo charger module (~$100, this week). Begin firmware work in parallel with sourcing.
2. **Request samples from Raytac** (MDBT50Q module). Free samples available with project description. 2-week lead.
3. **Quote request to Kyocera Fine Ceramics** for zirconia window prototype. Email their fine ceramics technical sales.
4. **JLCCNC quote** for 10 aluminum prototype shells. Upload STEP file, sub-$200.
5. **JLCPCB quote** for first PCB revision + flex tamper mesh.
6. **HAX or PCH intro call** — start the conversation now, even if you're not ready to commit. Lead times on accelerators are weeks; on manufacturing partners, months.
7. **Local Japan precision shop scouting** — for the Ti SKU. Visit DMM.make AKIBA next time you're in Tokyo, ask for referrals.
8. **Set up Digi-Key + Mouser + LCSC accounts** for one-off parts purchases.

---

**End of supply chain reference.**
