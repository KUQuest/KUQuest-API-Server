---
target: quest-scenarios.html
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-30T20-22-29Z
slug: docs-human-read-quest-scenarios-html
---
# KUQuest Scenario Master Simulation Suite: Tracing & Usability Critique

**Target Surface:** `docs/human-read/quest-scenarios.html` (13,548 lines, 120 simulation scenarios)
**Design Mode:** Read / Operate (Technical Documentation & Simulation Tracing Workbench)
**Primary User Goal:** *"ผมอยากให้คนที่มาอ่านสามารถ tracing ได้ง่ายที่สุด"* (Maximum tracing ergonomics for engineers, QA, domain auditors, and developers across 120 campus quest lifecycles and double-entry ledger state transitions).

---

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:-----:|-----------|
| 1 | **Visibility of System Status** | 3 / 4 | มีตัวนับผลลัพธ์การกรอง (Filter Counter) และ Active Badge ชัดเจน แต่ยังขาด Visual Scroll Progress, Visual State-Arc Timeline และ State Diff ระหว่าง Step |
| 2 | **Match System / Real World** | 4 / 4 | **โดดเด่นมาก**: Real-world Campus Story ("น้องกร", "พี่อ้อม", "นายบาส") แปลงกฎเทคนิคัลยากๆ ให้เข้าใจพฤติกรรมจริงของนิสิตได้ยอดเยี่ยม |
| 3 | **User Control and Freedom** | 3 / 4 | มีปุ่มรีเซ็ตตัวกรอง, กาง/หุบไดอะแกรมทั้งหมด และ direct URL anchor hash (`#SCENARIO-042`) แต่ยังขาดการ Bookmark, Pin เปรียบเทียบ 2 scenario หรือ Export test fixture |
| 4 | **Consistency and Standards** | 4 / 4 | โครงสร้างการ์ดทั้ง 120 ข้อมีระเบียบสูงมาก (6-tier schema: Header/Badges → Campus Story → Context → Step Execution Grid → Sequence Diagram → Invariant Notes → Rulebook Refs) |
| 5 | **Error Prevention** | 3 / 4 | Hover tooltips ช่วยป้องกันการสับสนคำศัพท์/State ได้ดี แต่กล่อง Search ยังเป็น plain substring matching ขาด fuzzy/typo tolerance |
| 6 | **Recognition Rather Than Recall** | 2 / 4 | Quick-Jump Matrix มีชิป 120 อัน (`SCENARIO-001` .. `120`) เป็นกล่องตัวเลขเปล่าๆ ไม่มีสีแสดงผลลัพธ์ (Success/Failed/Disputed) หรือ Quadrant tag ผู้อ่านต้องจำเลขเองหรือคอยเอาเมาส์ไล่ชี้ |
| 7 | **Flexibility and Efficiency** | 2 / 4 | ขาด Filter สำหรับ Tracing เชิงลึก เช่น กรองตาม State Transition (`QUEST_ASSIGNED -> QUEST_FAILED`), กรองตาม Ledger Compartment (`wallet_funding_reservations`, `PLATFORM_REVENUE`) |
| 8 | **Aesthetic and Minimalist Design** | 2 / 4 | **Extraneous Noise สูง**: Step ที่ไม่มีการโอนเงินหรือไม่มีไฟล์ ยังคงแสดงกล่อง `N/A` หรือ "ไม่มีการเคลื่อนไหวของเงิน" เต็มตาราง 6 ช่อง ทำให้เกิด Visual Clutter ตลอด 13,500+ บรรทัด |
| 9 | **Help Users Recognize & Recover from Errors** | 3 / 4 | เมื่อค้นหาไม่เจอผลลัพธ์ ตัวเลขจะบอก 0 ข้อ แต่ยังไม่มี Empty-State Recovery แนะนำการเคลียร์ตัวกรอง |
| 10 | **Help and Documentation** | 4 / 4 | ยอดเยี่ยมมาก: มีการอ้างอิง Authoritative Rulebook, Sub-contracts, ADRs และพจนานุกรมคำศัพท์พร้อม Modal ค้นหาแบบครบถ้วน |
| **Total** | | **30 / 40** | **Fair (75.0% - ต้องเสริมความแกร่งเพื่อการ Tracing เชิงวิศวกรรม)** |

---

## Design Specificity Verdict

- **LLM Assessment**: เอกสารถูกจัดวางในรูปแบบ **Linear Document Feed (การ์ดเรียงต่อกัน 120 ใบในหน้าเดียว)** ซึ่งอ่านภาพรวมได้ดี มีเรื่องเล่า Campus Story ที่เฉพาะตัวกับบริบทมหาวิทยาลัยเกษตรศาสตร์มาก แต่ยังขาดความเป็น **Interactive Tracing Workbench** หรือ **State Machine Debugger** การแสดงการเงิน Satang Math และ State Mutation ยังเป็นประโยคยาวทำให้อ่านแกะรอย (trace) ยากกว่าที่ควร
- **Deterministic Scan**: ตรวจพบ Antipatterns สไตล์ AI-generated UI ทั้งหมด 3 จุด:
  1. `side-tab` (line 153): `border-left: 5px solid #eab308` บน `.narrative-box`
  2. `side-tab` (line 159): `border-left: 4px solid var(--primary)` บน `.context-box`
  3. `dark-glow` (line 52): `box-shadow: 0 4px 12px rgba(2,132,199,0.35)` บนปุ่มเปิดพจนานุกรม
- **Visual Overlays**: โค้ด HTML ใช้งานได้ปกติผ่านเบราว์เซอร์ แต่การกด "กางไดอะแกรมทั้งหมด" จะรัน `mermaid.run()` พร้อมกัน 120 ไดอะแกรม ทำให้เบราว์เซอร์เกิด Render Jank / UI Freeze ชั่วคราว

---

## Overall Impression

เอกสารนี้มี **เนื้อหาและความสมบูรณ์ของกฎเกณฑ์ระดับ Masterpiece** เนื้อเรื่อง Campus Narrative ทำให้อนุมานพฤติกรรมผู้ใช้ได้เห็นภาพชัดเจนมาก อย่างไรก็ตาม เนื่องจากมีถึง **120 สถานการณ์และยาวกว่า 13,500 บรรทัด** การแสดงผลแบบการ์ดเรียงเดี่ยว (Vertical Card Stack) ทำให้เกิด **Cognitive Scroll Fatigue (ความล้าจากการเลื่อนหน้าจอ)** ผู้อ่านที่ต้องการแกะรอย (Trace) ข้อผิดพลาดหรือเปรียบเทียบเงื่อนไขต้องเลื่อนขึ้นลงหลายหน้าจอ

---

## What's Working

1. **Vivid Campus Story Layer (เชื่อมโยงโลกจริงกับโค้ด):** การใช้ตัวละครจริงของนิสิต (*น้องกร, พี่อ้อม, น้องหมิว, นายบาส*) ช่วยให้เข้าใจ Business Rules ที่ซับซ้อน เช่น การกระจายเศษสตางค์ (Remainder Satang) หรือการแบนแบบ Cascade ได้ทันที
2. **Interactive Term Tooltips & Modal Glossary:** ระบบ Tooltip ชี้คำศัพท์และ State ทำให้ผู้อ่านที่ไม่คุ้นเคยกับศัพท์ Domain เช่น `CONDUCT_OUT_OF_SCOPE`, `PC-11`, หรือ `Escrow` ได้รับคำอธิบายทันทีโดยไม่ต้องเปลี่ยนหน้า
3. **Rigorous Structural Discipline:** การ์ดทุกใบรักษาโครงสร้าง 6 ระดับ (Badges → Story → Context → Execution Steps → Diagram → Notes → Rulebook Refs) ได้อย่างสม่ำเสมอ 100%

---

## Priority Issues

### 🚨 [P1] Monolithic Single-Column Layout & Excessive Scroll Fatigue
- **Why it matters:** 120 การ์ดรวมกันสูงหลายหมื่นพิกเซล เมื่อต้องการ Tracing หรือค้นหาเคสที่เชื่อมโยงกัน (เช่น Scenario 015 เทียบกับ Scenario 073) ผู้ใช้ต้องไถหน้าจอเป็นเวลานานจนเกิด Card Blindness
- **Fix:** เพิ่มโหมด **Master-Detail Split View (หรือ 2-Pane Workbench Mode)**:
  - **แถบซ้าย (Sidebar Master):** รายการเควสต์ 120 ข้อแบบกะทัดรัด พร้อม Badges, State Arcs, และเงินรางวัล
  - **แถบขวา (Detail Inspector):** แสดงเนื้อเรื่อง, ลำดับ Step, การเคลื่อนไหวของเงิน, และ Sequence Diagram ของข้อที่เลือก
- **Suggested command:** `/impeccable layout`

### 🚨 [P1] Ledger Satang Math & State Mutations ขาดการทำ Visual Diffing
- **Why it matters:** ขณะนี้ข้อมูลบัญชี Satang Math (Double-Entry Ledger) เขียนเป็นข้อความบรรยายร้อยแก้วยาวๆ ผู้อ่านต้องอ่านทีละประโยคเพื่อบวกเลขในใจว่า Debit = Credit หรือไม่ และ State เปลี่ยนจากอะไรเป็นอะไร
- **Fix:** 
  1. เพิ่ม **State Transition Diff Badge** ในแต่ละ Step เช่น `QUEST_OPEN` ➔ `QUEST_ASSIGNED`
  2. จัดรูปแบบการเงินใน Step ด้วย **T-Account Ledger Table** (Debit (-) / Credit (+)) ให้เห็นกระเป๋าเงินต้นทางและปลายทางชัดเจน
- **Suggested command:** `/impeccable clarify`

### ⚠️ [P2] Quick Jump Matrix ขาด Information Density และ Semantic Color
- **Why it matters:** ชิป 120 อันใน Matrix ด้านบนแสดงเพียงรหัส `SCENARIO-001` .. `120` เป็นสีขาว-เทาเหมือนกันหมด ผู้ใช้ไม่สามารถกวาดสายตาหาเคสที่ Fail, Disputed หรือ Moderated ได้โดยตรง
- **Fix:** แบ่งกลุ่ม Matrix ตาม Quadrant Tabs (Q1 FCFS Single, Q2 Candidate Single, Q3 FCFS Group, Q4 Candidate Team, Admin) พร้อมใส่สีที่ชิปตาม Outcome (เขียว = Success, แดง = Failed, ส้ม = Cancelled/Disputed, ม่วง = Moderated)
- **Suggested command:** `/impeccable colorize`

### ⚠️ [P2] Mermaid Sequence Diagrams Render Lag & Note Truncation
- **Why it matters:** การกางไดอะแกรมพร้อมกันทำให้เว็บกระตุกอย่างรุนแรง และข้อความในไดอะแกรมบางจุดถูกตัดทอนด้วย `...` ทำให้อ่านชื่อ Actor หรือจำนวนเงินสตางค์ไม่ครบ
- **Fix:** ใช้ `IntersectionObserver` ทำ Lazy Rendering สำหรับ Mermaid Diagram และปรับข้อความใน Note ให้ขึ้นบรรทัดใหม่แทนการตัดคำ
- **Suggested command:** `/impeccable optimize`

### 💡 [P3] Rulebook References & CLI Test Specs ยังไม่เป็น Interactive Link
- **Why it matters:** อ้างอิงไฟล์ Rulebook และ Test Spec เป็นเพียงโค้ดข้อความธรรมดา ไม่สามารถคลิกเปิดไฟล์หรือก๊อปปี้คำสั่งรันเทสไปวางในเทอร์มินัลได้ทันที
- **Fix:** ใส่ปุ่ม "📋 Copy Test Command" (เช่น `pnpm test test/integration/scenario-049.spec.ts`) และทำลิงก์เปิดไฟล์
- **Suggested command:** `/impeccable polish`

---

## Persona Red Flags

- **🛠️ Developer / Backend Auditor:** ใช้เวลาถอดรหัสการโอนเงินสตางค์ (Satang Ledger) นานเกินไปเพราะไม่มีตาราง Balance Sheet แบบ Double-Entry
- **🧪 QA Engineer (Tracing Edge Cases):** ไม่สามารถกรองเฉพาะ Scenario ที่มี State Transition เฉพาะเจาะจง (เช่น เกิดข้อพิพาทหลังเควสต์ล้มเหลว) และไม่สามารถก๊อปปี้ชุดข้อมูลไปสร้าง Test Fixture ได้ทันที
- **🎓 New Contributor / Onboarding:** รู้สึก Overwhelmed กับความยาว 13,500 บรรทัด ขาดภาพรวม State Machine Lifecycle Diagram ด้านบนสุดของหน้าเพื่อเป็นเข็มทิศนำทางก่อนอ่านเคสย่อย

---

## Minor Observations

1. **Search Input Debounce:** ฟังก์ชันค้นหายังวนลูปเช็ค DOM ทุกครั้งที่กดแป้นพิมพ์ ควรใส่ `debounce(150ms)` เพื่อความลื่นไหล
2. **Tooltip Viewport Clipping:** เมื่อชี้คำศัพท์ที่อยู่ชิดขอบจอขวา Tooltip ลอยหลุดขอบจอในบางขนาดหน้าจอ ควรใช้ bounding rect คำนวณขอบจออัตโนมัติ
3. **Redundant N/A Placeholders:** ใน Step ที่ไม่มีการส่งไฟล์หรือไม่มีการเคลื่อนไหวของเงิน ควบรวมช่องหรือซ่อนช่องว่างเพื่อลดความสูงของการ์ดลง 30%

---

## Questions to Consider

- *"ถ้าหน้าเว็บมีปุ่มสลับระหว่าง 'Document View' (แบบอ่านนิยายยาว) กับ 'Debugger Workbench View' (แบบสปลิต 2 ฝั่งสำหรับไล่โค้ด) จะช่วยตอบโจทย์ทั้งสายอ่านและสายแกะรอยได้ดีขึ้นหรือไม่?"*
- *"เราควรใส่แผนภาพ State Machine รวมทั้งระบบไว้ใต้ Header ก่อนเริ่ม Scenario 001 หรือไม่ เพื่อให้ผู้อ่านเห็นภาพรวมก่อนกระโดดลงไปดูเคสย่อย?"*
