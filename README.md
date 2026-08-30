# KUQuest API Server

ยินดีต้อนรับสู่ **KUQuest API Server** — บริการแบ็กเอนด์หลักสำหรับระบบว่าจ้างและช่วยเหลือนิสิต มหาวิทยาลัยเกษตรศาสตร์ (KUQuest Mobile และ KUQuest Admin Web App) พัฒนาด้วย **Elysia**, **Bun**, **PostgreSQL** และ **RustFS**

- 🚀 **เริ่มต้นติดตั้งและรันระบบ:** ดูขั้นตอนอย่างละเอียดที่ [SETUP.md](SETUP.md)
- 📜 **อ่านกฎเกณฑ์ทางธุรกิจและสเปกระบบ:** ดูสารบัญ [Domain Rulebooks & Architecture](#-domain-rulebooks--specifications)
- 🎮 **เปิดดูการจำลองพฤติกรรมระบบ (120 สถานการณ์):** ดูที่ [human-read/quest-scenarios.html](human-read/quest-scenarios.html)

---

## 📚 Domain Rulebooks & Specifications

ระบบ KUQuest ขับเคลื่อนด้วยนโยบายทางธุรกิจที่ถูกกำหนดไว้อย่างเป็นเอกภาพใน **Domain Rulebooks** และ **Architectural Decision Records (ADRs)**:

```text
docs/
├── rulebook/                  # 🌟 กฎเกณฑ์ทางธุรกิจฉบับทางการ (Authoritative Target Policy)
│   ├── quest/                 # นโยบายวงจรชีวิตเควสต์, แชต, การส่งงาน และการยกเลิก
│   ├── admin/                 # นโยบายการตรวจสอบ, ระงับข้อพิพาท, อนุมัติถอนเงิน และบทลงโทษ
│   └── finance/               # นโยบายบัญชีคู่ (Double-Entry Ledger) และการจัดสรรเงินมัดจำ
├── adr/                       # บันทึกการตัดสินใจเชิงสถาปัตยกรรม (Architectural Decision Records)
├── quest/                     # คู่มือเทียบโค้ดกับนโยบาย (Quest Reconciliation Guide)
├── admin/                     # คู่มือเทียบโค้ดกับนโยบาย (Admin Reconciliation Guide)
└── human-read/                # เอกสารจำลองสถานการณ์และ Flow การทำงานสำหรับผู้อ่าน
```

### 1. 📘 กฎเกณฑ์เควสต์และการประสานงาน (Quest & Work Chat Rulebook)
- **ไฟล์หลัก**: [`docs/rulebook/quest/quest-work-chat-rulebook.md`](docs/rulebook/quest/quest-work-chat-rulebook.md)
- **ครอบคลุม**:
  - วงจรชีวิตเควสต์ทั้ง 4 จตุภาค (Single/Group × FCFS/Candidate)
  - สัญญาห้องสนทนา Work Chat และ Candidate Inquiry แยกต่างหาก ([ADR 0019](docs/adr/0019-separate-candidate-inquiry-conversation.md))
  - การตรวจรับงานและเงื่อนไขไม่ผ่านส่งผลให้เควสต์ล้มเหลว ([ADR 0016](docs/adr/0016-not-approved-proof-fails-quest.md))
  - เมทริกซ์การยกเลิกเควสต์ 3 ระดับ (3-Tier Cancellation Matrix: คืน 100% / ชดเชย 20% / จ่ายเต็ม 100%)
  - หน้าต่างขอแก้ไขเควสต์ 10 นาที (10-Minute Quest Edit Window)

### 2. 🛡️ กฎเกณฑ์ผู้ดูแลระบบและความปลอดภัย (Admin Operations Rulebook)
- **ไฟล์หลัก**: [`docs/rulebook/admin/admin-rulebook.md`](docs/rulebook/admin/admin-rulebook.md)
- **ครอบคลุม**:
  - การอนุมัติคำขอถอนเงินรางวัลแบบ Manual ([ADR 0022](docs/adr/0022-manual-admin-approval-for-payouts.md))
  - การระงับข้อพิพาทและการจัดสรรเงินมัดจำที่พักไว้ 7 วัน ([ADR 0024](docs/adr/0024-hold-quest-failure-settlement-for-dispute-window.md))
  - การสั่งซ่อนเควสต์ไม่ปลอดภัยโดยคงเงินมัดจำ Escrow ไว้ ([ADR 0021](docs/adr/0021-keep-escrow-during-moderation-hide.md))
  - การควบคุมกระเป๋าเงิน (Wallet Freeze/Suspend) และการคุ้มครองงานที่กำลังดำเนินอยู่
  - บันไดบทลงโทษสมาชิก (Misconduct Ladder & Low-Average-Review Ladder, Red Flag, Auto-Freeze)

### 3. 💰 กฎเกณฑ์การเงินและบัญชีคู่ (Finance & Wallets Rulebook)
- **ไฟล์หลัก**: [`docs/rulebook/finance/finance-rulebook.md`](docs/rulebook/finance/finance-rulebook.md)
- **ครอบคลุม**:
  - ระบบบัญชีแยกประเภทคู่ (Double-Entry Ledger) คำนวณในหน่วยสตางค์จำนวนเต็ม ([ADR 0005](docs/adr/0005-integer-satang-for-money.md))
  - บัญชีย่อยของกระเป๋าเงิน (SPENDING, EARNINGS, Quest Escrow, Funding Reservation)
  - ความคงทนและการแก้ไขข้อผิดพลาดทางการเงินแบบไม่ลบประวัติ ([ADR 0010](docs/adr/0010-retain-and-correct-financial-records.md))
  - การเข้ารหัสข้อมูลเลขที่บัญชีธนาคารปลายทางด้วย AES-256-GCM ([ADR 0008](docs/adr/0008-encrypt-payout-destination-secrets.md))

### 4. 📖 พจนานุกรมศัพท์ทางการ (Ubiquitous Language)
- **ไฟล์หลัก**: [`CONTEXT.md`](CONTEXT.md)
- นิยามศัพท์เฉพาะ เช่น `Hirer`, `Worker`, `Candidate`, `Red Flag`, `Quest Escrow`, `Double-Entry Ledger`, `Remainder Satang` เพื่อให้ทีมพัฒนาและเอกสารใช้ภาษาเดียวกันทั้งหมด

---

## 🎮 Interactive Simulation Suite (สำหรับมนุษย์อ่าน)

สำหรับผู้ที่ต้องการทำความเข้าใจพฤติกรรมของระบบอย่างเห็นภาพ ทางโครงการได้จัดทำชุดสถานการณ์จำลองแบบ Interactive ไว้อย่างครบถ้วน:

* **ไฟล์เอกสาร**: [`human-read/quest-scenarios.html`](human-read/quest-scenarios.html) *(หรือ `docs/human-read/quest-scenarios.html`)*
* **ฟีเจอร์เด่น**:
  * 🎯 รวม **120 สถานการณ์จำลองจริง** พร้อม **📖 เรื่องเล่าจำลองสถานการณ์จริง (Campus Story)**
  * 💬 **Interactive Tooltips & Tracing**: นำเมาส์ไปชี้ที่สถานะ (`QUEST_OPEN`, `QUEST_ASSIGNED`, `ASSIGNMENT_ACTIVE`, `PROOF_SUBMITTED`) หรือรหัสบทลงโทษ (`CONDUCT_OUT_OF_SCOPE`, `PC-11`, `Red Flag`) เพื่อดูคำนิยามและผลลัพธ์ทันที
  * 📊 **Sequence Diagrams (Mermaid)**: แผนภาพแสดงลำดับข้อความ การเรียก API และการลงบัญชีคู่ทุกขั้นตอน
  * 🎛️ **Multi-Facet Filter Hub**: กรองตามโหมดเควสต์, ผลลัพธ์, ผู้เกี่ยวข้อง หรือประเภทสถานการณ์ได้ทันที

เปิดดูด้วยเบราว์เซอร์:
```bash
xdg-open human-read/quest-scenarios.html
```

---

## 📂 โครงสร้างโปรเจกต์ (Project Structure)

```text
.
├── docs/                      # เอกสารสเปก นโยบาย และคำอธิบายเชิงสถาปัตยกรรม
│   ├── rulebook/              # นโยบายทางการ (Quest, Admin, Finance)
│   ├── adr/                   # Architectural Decision Records
│   ├── human-read/            # เอกสารจำลองสถานการณ์ HTML
│   └── db/                    # เอกสาร Database และ EDR SQL
├── human-read -> docs/human-read # Symlink สำหรับเข้าถึงเอกสารจำลองสถานการณ์ได้สะดวก
├── src/
│   ├── config/                # ค่า Configuration และ Environment Validation
│   ├── database/              # Drizzle ORM Schema และ Database Client
│   ├── modules/               # Feature Modules (Auth, Quest, Wallet, Admin, Profile, Onboarding)
│   ├── plugins/               # Cross-cutting Elysia Plugins (Error handler, Logging, Security)
│   ├── app.ts                 # การประกอบ Route และ Middleware
│   └── index.ts               # HTTP Server Entrypoint
├── scripts/                   # Migration, Seeding, Workers และ Verification Scripts
├── tests/                     # Automated Test Suites (Unit, Integration, Contract)
├── drizzle/                   # SQL Migrations และ Migration Journal
├── public/                    # API Test Bench และ Static Assets
├── SETUP.md                   # 🚀 คู่มือการติดตั้ง รัน และทดสอบระบบ
└── CONTEXT.md                 # 📖 พจนานุกรมศัพท์ทางการของระบบ
```

---

## 🤝 การมีส่วนร่วมและข้อกำหนด Pull Request (PR Rules)

- **Application, Database & Documentation PRs**: ให้เปิด PR โดยมี Base Branch ชี้ไปที่ **`develop`**
- **GitHub Actions Workflows (`.github/workflows/`)**: หากมีการแก้ไขไฟล์ Workflow ให้เปิด PR แยกต่างหากโดยมี Base Branch ชี้ไปที่ **`main`** (ตามข้อกำหนดใน [AGENTS.md](AGENTS.md))
