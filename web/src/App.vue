<script setup lang="ts">
import QRCode from 'qrcode';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { ApiError, createApi, idempotencyKey, type RequestLog } from './api';
import DebugPanel from './components/DebugPanel.vue';
import FlowSteps from './components/FlowSteps.vue';
import MoneyCard from './components/MoneyCard.vue';
import { findUserByIdentifier, isSelectedWorker, userIdentifier } from './job-flow';

interface User { id?: string; user_id?: string; name: string; email: string }
interface Session { user: User; session: { id: string } }
interface Context { root_user: User; active_user: User; acting_as_test_user: boolean }
interface Wallet { spending_balance: number; earnings_balance: number; held_for_jobs: number; reserved_for_payouts: number; status: string; as_of: string }
interface Quote { id: string; credit_baht: number; payment_total_baht: number; fee_baht: number; tax_baht: number; expires_at: string }
interface TopUp { id: string; reference: string; credit_baht: number; payment_total_baht: number; status: string; qr_string?: string; provider_reference?: string; created_at: string }
interface Job { id: string; employer_user_id: string; intended_payee_user_id?: string | null; selected_worker_user_id?: string | null; title: string; description: string; status: string; job_amount: number; worker_net_amount: number; application_deadline: string; work_deadline: string }
interface Application { id: string; worker_user_id: string; message: string; status: string; created_at: string }
interface PayoutAccount { id: string; account_holder_name: string; bank_code: string; masked_account_number: string }
interface PayoutQuote { id: string; receipt_baht: number; maximum_debit_baht: number; expires_at: string }
interface Payout { id: string; reference: string; principal_baht: number; status: string; destination: { bank_code: string; masked_account_number: string }; created_at: string }
interface Activity { id: string; type: string; title: string; status: string; spending_delta: number; earnings_delta: number; held_jobs_delta: number; reserved_payouts_delta: number; occurred_at: string }

const endpoint = {
  session: '/api/auth/get-session', signIn: '/api/auth/sign-in/social', signOut: '/api/auth/sign-out',
  users: '/v1/development/test-users', actorSessions: '/v1/development/actor-sessions',
  actorSession: '/v1/development/actor-session', context: '/v1/development/session-context',
  wallet: '/v1/wallet', topUpQuotes: '/v1/wallet/top-up-quotes', topUps: '/v1/wallet/top-ups',
  payoutAccount: '/v1/wallet/payout-account', payoutQuotes: '/v1/wallet/payout-quotes', payouts: '/v1/wallet/payouts',
  jobs: '/v1/jobs', activities: '/v1/wallet/activities?limit=100', diagnostics: '/v1/development/money-diagnostics',
};

const logs = ref<RequestLog[]>([]);
const request = createApi((entry) => { logs.value.unshift(entry); logs.value = logs.value.slice(0, 150); });
const session = ref<Session | null>(null);
const context = ref<Context | null>(null);
const users = ref<User[]>([]);
const wallet = ref<Wallet | null>(null);
const topUps = ref<TopUp[]>([]);
const jobs = ref<Job[]>([]);
const activities = ref<Activity[]>([]);
const payoutAccount = ref<PayoutAccount | null>(null);
const payouts = ref<Payout[]>([]);
const diagnostics = ref<unknown>(null);
const activeStep = ref(0);
const busy = ref(0);
const error = ref('');
const notice = ref('');
const debugOpen = ref(false);

const topUpAmount = ref(500);
const topUpQuote = ref<Quote | null>(null);
const activeTopUp = ref<TopUp | null>(null);
const qrImage = ref('');
let topUpPoll: number | undefined;

const futureLocal = (hours: number) => {
  const date = new Date(Date.now() + hours * 3_600_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};
const jobForm = ref({ title: 'ช่วยตรวจเอกสารโครงการ', description: 'ตรวจความถูกต้องและสรุปข้อเสนอแนะ', job_amount: 300, application_deadline: futureLocal(24), work_deadline: futureLocal(72) });
const flowJob = ref<Job | null>(null);
const applications = ref<Application[]>([]);
const applicationMessage = ref('พร้อมทำงานและส่งตามกำหนด');
const submissionSummary = ref('ตรวจเอกสารและสรุปข้อเสนอแนะเรียบร้อยแล้ว');

const accountForm = ref({ given_name: 'Test', surname: 'Worker', account_holder_name: 'Test Worker', account_number: '121212', bank_code: 'BBL' });
const payoutAmount = ref(100);
const payoutQuote = ref<PayoutQuote | null>(null);
const activePayout = ref<Payout | null>(null);

const userId = userIdentifier;
const activeUser = computed(() => context.value?.active_user ?? session.value?.user ?? null);
const rootUser = computed(() => context.value?.root_user ?? session.value?.user ?? null);
const allUsers = computed(() => {
  const seen = new Set<string>();
  return [rootUser.value, ...users.value].filter((user): user is User => Boolean(user) && !seen.has(userId(user)) && Boolean(seen.add(userId(user))));
});
const isEmployer = computed(() => flowJob.value?.employer_user_id === userId(activeUser.value));
const isWorker = computed(() => isSelectedWorker(flowJob.value, activeUser.value));
const completed = computed(() => {
  const result: number[] = [];
  if (topUps.value.some((item) => item.status === 'SUCCEEDED')) result.push(0);
  if (flowJob.value) result.push(1);
  if (flowJob.value?.status === 'SETTLED') result.push(2);
  if (payouts.value.some((item) => item.status === 'SUCCEEDED')) result.push(3);
  return result;
});

const money = (value?: number) => value === undefined ? '—' : `${new Intl.NumberFormat('th-TH').format(value)} ฿`;
const dateTime = (value?: string) => value ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const statusTone = (status: string) => /SUCCEEDED|SETTLED|ACTIVE|SELECTED/.test(status) ? 'success' : /FAILED|CANCELLED|EXPIRED|REVERSED|RECONCILIATION/.test(status) ? 'danger' : 'pending';

const run = async <T,>(work: () => Promise<T>, success = ''): Promise<T | undefined> => {
  busy.value += 1; error.value = ''; notice.value = '';
  try {
    const result = await work();
    notice.value = success;
    return result;
  } catch (cause) {
    const apiError = cause as ApiError;
    error.value = `${apiError.message}${apiError.code ? ` · ${apiError.code}` : ''}${apiError.traceId ? ` · trace ${apiError.traceId}` : ''}`;
  } finally { busy.value -= 1; }
};

const command = <T,>(path: string, body: unknown, kind: string) => request<T>(path, {
  method: 'POST', headers: { 'Idempotency-Key': idempotencyKey(kind) }, body: JSON.stringify(body),
});

async function refreshSession() {
  const current = await run(() => request<Session | null>(endpoint.session));
  session.value = current ?? null;
  if (session.value) await loadAll();
}

async function signIn() {
  const result = await run(() => request<{ url: string }>(endpoint.signIn, { method: 'POST', body: JSON.stringify({
    provider: 'google', callbackURL: `${location.origin}/`, errorCallbackURL: `${location.origin}/`, disableRedirect: true,
  }) }));
  if (result?.url) location.assign(result.url);
}

async function signOut() {
  await run(() => request(endpoint.signOut, { method: 'POST', body: '{}' }));
  location.assign('/');
}

async function loadAll() {
  const [contextResult, usersResult, walletResult, topUpResult, mine, market, assigned, activityResult, accountResult, payoutResult, diagnosticResult] = await Promise.allSettled([
    request<Context>(endpoint.context), request<{ items: User[] }>(endpoint.users), request<Wallet>(endpoint.wallet), request<TopUp[]>(endpoint.topUps),
    request<{ items: Job[] }>(`${endpoint.jobs}?scope=mine&limit=100`), request<{ items: Job[] }>(`${endpoint.jobs}?scope=marketplace&limit=100`),
    request<{ items: Job[] }>(`${endpoint.jobs}?scope=assigned&limit=100`), request<{ items: Activity[] }>(endpoint.activities),
    request<PayoutAccount | null>(endpoint.payoutAccount), request<Payout[]>(endpoint.payouts), request(endpoint.diagnostics),
  ]);
  if (contextResult.status === 'fulfilled') context.value = contextResult.value;
  if (usersResult.status === 'fulfilled') users.value = usersResult.value.items;
  if (walletResult.status === 'fulfilled') wallet.value = walletResult.value;
  if (topUpResult.status === 'fulfilled') topUps.value = topUpResult.value;
  const combined = [mine, market, assigned].flatMap((result) => result.status === 'fulfilled' ? result.value.items : []);
  jobs.value = [...new Map(combined.map((job) => [job.id, job])).values()];
  if (flowJob.value) flowJob.value = jobs.value.find((job) => job.id === flowJob.value?.id) ?? flowJob.value;
  if (activityResult.status === 'fulfilled') activities.value = activityResult.value.items;
  if (accountResult.status === 'fulfilled') payoutAccount.value = accountResult.value;
  if (payoutResult.status === 'fulfilled') payouts.value = payoutResult.value;
  if (diagnosticResult.status === 'fulfilled') diagnostics.value = diagnosticResult.value;
}

async function refreshAll() { await run(loadAll, 'อัปเดตข้อมูลแล้ว'); }

async function switchActor(target: User) {
  const root = userId(target) === userId(rootUser.value);
  await run(async () => {
    if (root) await request(endpoint.actorSession, { method: 'DELETE' });
    else await request(endpoint.actorSessions, { method: 'POST', body: JSON.stringify({ user_id: userId(target) }) });
    await loadAll();
    if (flowJob.value?.status === 'OPEN' && flowJob.value.employer_user_id === userId(activeUser.value)) {
      const result = await request<{ items: Application[] }>(`${endpoint.jobs}/${flowJob.value.id}/applications?limit=100`);
      applications.value = result.items;
    }
  }, `กำลังใช้งานเป็น ${target.name}`);
}

async function createTestUser() {
  const name = window.prompt('ชื่อผู้ใช้ทดสอบ', 'Worker Test');
  if (!name) return;
  await run(async () => { await request(endpoint.users, { method: 'POST', body: JSON.stringify({ name }) }); await loadAll(); }, 'สร้างผู้ใช้ทดสอบแล้ว');
}

async function quoteTopUp() {
  topUpQuote.value = await run(() => request<Quote>(endpoint.topUpQuotes, { method: 'POST', body: JSON.stringify({ credit_baht: topUpAmount.value }) })) ?? null;
}

async function createTopUp() {
  if (!topUpQuote.value) return;
  const created = await run(() => command<TopUp>(endpoint.topUps, { quote_id: topUpQuote.value?.id }, 'topup'), 'สร้าง PromptPay แล้ว');
  if (!created) return;
  activeTopUp.value = created; topUps.value.unshift(created);
  qrImage.value = created.qr_string ? await QRCode.toDataURL(created.qr_string, { width: 240, margin: 1 }) : '';
}

async function simulateTopUp() {
  if (!activeTopUp.value) return;
  await run(() => request(`${endpoint.topUps}/${activeTopUp.value?.id}/simulate`, { method: 'POST', body: '{}' }), 'ส่งคำขอจำลองไป Xendit แล้ว');
  window.clearInterval(topUpPoll);
  topUpPoll = window.setInterval(async () => {
    if (!activeTopUp.value) return;
    const updated = await request<TopUp>(`${endpoint.topUps}/${activeTopUp.value.id}`).catch(() => null);
    if (!updated) return;
    activeTopUp.value = updated;
    if (['SUCCEEDED', 'FAILED', 'EXPIRED', 'AWAITING_RECONCILIATION'].includes(updated.status)) {
      window.clearInterval(topUpPoll); await loadAll();
    }
  }, 2500);
}

async function createJob() {
  const body = { ...jobForm.value, application_deadline: new Date(jobForm.value.application_deadline).toISOString(), work_deadline: new Date(jobForm.value.work_deadline).toISOString() };
  const created = await run(() => command<Job>(endpoint.jobs, body, 'job'), 'สร้างงานและพักเงินแล้ว');
  if (created) { flowJob.value = created; activeStep.value = 1; await loadAll(); }
}

async function chooseJob(job: Job) {
  flowJob.value = job;
  applications.value = [];
  if (job.status === 'OPEN' && job.employer_user_id === userId(activeUser.value)) await loadApplications();
}

async function applyForJob() {
  if (!flowJob.value) return;
  await run(() => command(`${endpoint.jobs}/${flowJob.value?.id}/applications`, { message: applicationMessage.value }, 'apply'), 'สมัครงานแล้ว');
  await loadAll();
}

async function loadApplications() {
  if (!flowJob.value) return;
  const result = await run(() => request<{ items: Application[] }>(`${endpoint.jobs}/${flowJob.value?.id}/applications?limit=100`));
  applications.value = result?.items ?? [];
}

async function selectWorker(application: Application) {
  if (!flowJob.value) return;
  const updated = await run(() => command<Job>(`${endpoint.jobs}/${flowJob.value?.id}/worker-selection`, { application_id: application.id }, 'select'), 'เลือกผู้ทำงานแล้ว');
  if (!updated) return;
  flowJob.value = updated;
  activeStep.value = 2;
  await loadAll();

  const selectedUser = findUserByIdentifier(allUsers.value, application.worker_user_id);
  if (selectedUser) {
    await switchActor(selectedUser);
    notice.value = `เลือก ${selectedUser.name} เป็นผู้ทำงานแล้ว — พร้อมส่งงาน`;
  } else {
    notice.value = 'เลือกผู้ทำงานแล้ว — สลับเป็นผู้ใช้ที่ได้รับเลือกเพื่อส่งงาน';
  }
}

async function submitWork() {
  if (!flowJob.value) return;
  const updated = await run(() => command<Job>(`${endpoint.jobs}/${flowJob.value?.id}/work-submission`, { summary: submissionSummary.value }, 'submit'), 'ส่งงานแล้ว');
  if (updated) flowJob.value = updated;
  await loadAll();
}

async function approveWork() {
  if (!flowJob.value || !window.confirm('อนุมัติงานและโอนเงินเข้ากระเป๋ารายได้ของผู้ทำงาน?')) return;
  const updated = await run(() => command<Job>(`${endpoint.jobs}/${flowJob.value?.id}/approval`, {}, 'approve'), 'อนุมัติและจ่ายรายได้แล้ว');
  if (updated) flowJob.value = updated;
  await loadAll();
}

async function savePayoutAccount() {
  await run(() => request(endpoint.payoutAccount, { method: 'POST', body: JSON.stringify(accountForm.value) }), 'บันทึกบัญชีรับเงินแล้ว');
  accountForm.value.account_number = '';
  await loadAll();
}

async function quotePayout() {
  payoutQuote.value = await run(() => request<PayoutQuote>(endpoint.payoutQuotes, { method: 'POST', body: JSON.stringify({ receipt_baht: payoutAmount.value }) })) ?? null;
}

async function createPayout() {
  if (!payoutQuote.value || !window.confirm('ส่งคำขอถอนผ่าน Xendit test mode?')) return;
  activePayout.value = await run(() => command<Payout>(endpoint.payouts, { quote_id: payoutQuote.value?.id }, 'payout'), 'Xendit รับคำขอถอนแล้ว') ?? null;
  await loadAll();
}

onMounted(() => {
  const oauthError = new URLSearchParams(location.search).get('error');
  if (oauthError) { error.value = `Google login ไม่สำเร็จ: ${oauthError}`; history.replaceState({}, '', '/'); }
  void refreshSession();
});
onBeforeUnmount(() => window.clearInterval(topUpPoll));
</script>

<template>
  <div v-if="!session" class="login-page">
    <main class="login-card">
      <div class="brand"><span>KQ</span><strong>KUQuest</strong><small>TEST MODE</small></div>
      <p class="eyebrow">Money flow showcase</p>
      <h1>ทดสอบเงินเข้า งาน และรายได้ในหน้าจอเดียว</h1>
      <p class="lead">เข้าสู่ระบบด้วยบัญชีมหาวิทยาลัย จากนั้นทดลองกระบวนการจริงตั้งแต่ PromptPay จนถึง Xendit payout</p>
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <button class="button primary large" type="button" :disabled="busy > 0" @click="signIn">เข้าสู่ระบบด้วย Google</button>
      <button class="button secondary" type="button" :disabled="busy > 0" @click="refreshSession">ตรวจสอบ session</button>
      <p class="muted small-text">อนุญาตเฉพาะบัญชีที่ลงท้ายด้วย @ku.th</p>
    </main>
  </div>

  <div v-else class="app-shell">
    <header class="topbar">
      <div class="brand"><span>KQ</span><strong>KUQuest</strong><small>TEST MODE</small></div>
      <div class="top-actions">
        <span class="connection"><i></i>{{ busy ? 'กำลังเชื่อมต่อ' : 'เชื่อมต่อ API แล้ว' }}</span>
        <button class="button secondary small" type="button" :disabled="busy > 0" @click="refreshAll">รีเฟรช</button>
        <button class="button secondary small" type="button" @click="debugOpen = true">API log <b>{{ logs.length }}</b></button>
        <button class="button ghost small" type="button" @click="signOut">ออกจากระบบ</button>
      </div>
    </header>

    <section class="actor-bar" aria-label="เลือกผู้ใช้ทดสอบ">
      <div class="actor-label"><small>กำลังใช้งานเป็น</small><strong>{{ activeUser?.name }}</strong></div>
      <div class="actor-list">
        <button v-for="user in allUsers" :key="userId(user)" type="button" class="actor-button"
          :class="{ active: userId(user) === userId(activeUser) }" :disabled="busy > 0" @click="switchActor(user)">
          <span>{{ user.name.slice(0, 1).toUpperCase() }}</span><span>{{ user.name }}<small>{{ user.email }}</small></span>
        </button>
      </div>
      <button class="button secondary small" type="button" @click="createTestUser">+ ผู้ใช้ทดสอบ</button>
    </section>

    <div class="layout">
      <aside class="sidebar">
        <p class="eyebrow">Showcase flow</p>
        <FlowSteps :active="activeStep" :completed="completed" @select="activeStep = $event" />
        <div class="sidebar-note">
          <strong>บทบาทปัจจุบัน</strong>
          <span>{{ context?.acting_as_test_user ? 'ผู้ใช้ทดสอบปกติ' : 'ผู้ทดสอบหลัก' }}</span>
          <small>{{ activeUser?.email }}</small>
        </div>
      </aside>

      <main class="content">
        <div class="page-heading">
          <div><p class="eyebrow">Step {{ activeStep + 1 }} of 5</p><h1>{{ ['เติมเงินเข้ากระเป๋า','สร้างและรับงาน','ส่งงานและจ่ายรายได้','ถอนรายได้','กิจกรรมทางการเงิน'][activeStep] }}</h1></div>
          <span class="status" :class="statusTone(wallet?.status ?? '')">{{ wallet?.status ?? 'LOADING' }}</span>
        </div>
        <p v-if="error" class="alert error" role="alert">{{ error }}</p>
        <p v-if="notice" class="alert success" role="status">{{ notice }}</p>

        <section class="money-grid" aria-label="ยอดเงินปัจจุบัน">
          <MoneyCard label="เงินใช้จ่าย" :amount="wallet?.spending_balance" tone="accent" hint="ใช้สร้างงาน" />
          <MoneyCard label="รายได้" :amount="wallet?.earnings_balance" hint="ถอนได้เมื่อรับงานสำเร็จ" />
          <MoneyCard label="พักไว้ในงาน" :amount="wallet?.held_for_jobs" />
          <MoneyCard label="กำลังถอน" :amount="wallet?.reserved_for_payouts" />
        </section>

        <section v-if="activeStep === 0" class="section-grid">
          <article class="panel">
            <p class="step-number">01</p><h2>ขอราคาเติมเงิน</h2><p class="muted">สร้าง PromptPay ผ่าน Xendit test mode</p>
            <form class="form" @submit.prevent="quoteTopUp">
              <label>จำนวนเงิน (บาท)<input v-model.number="topUpAmount" type="number" min="1" required /></label>
              <button class="button primary" type="submit" :disabled="busy > 0">คำนวณยอดชำระ</button>
            </form>
            <div v-if="topUpQuote" class="quote">
              <div><span>เงินเข้ากระเป๋า</span><strong>{{ money(topUpQuote.credit_baht) }}</strong></div>
              <div><span>ค่าธรรมเนียม</span><strong>{{ money(topUpQuote.fee_baht + topUpQuote.tax_baht) }}</strong></div>
              <div class="total"><span>ยอดชำระ</span><strong>{{ money(topUpQuote.payment_total_baht) }}</strong></div>
              <button class="button primary full" type="button" @click="createTopUp">สร้าง PromptPay</button>
            </div>
          </article>
          <article class="panel payment-panel">
            <template v-if="activeTopUp">
              <div class="panel-heading"><div><p class="step-number">02</p><h2>ชำระเงิน</h2></div><span class="status" :class="statusTone(activeTopUp.status)">{{ activeTopUp.status }}</span></div>
              <img v-if="qrImage" class="qr" :src="qrImage" alt="PromptPay QR สำหรับทดสอบ" />
              <p class="reference">{{ activeTopUp.reference }}</p>
              <p class="muted">QR test อาจไม่สามารถชำระจริงได้ ใช้ปุ่มจำลองเพื่อให้ Xendit ส่ง webhook</p>
              <button v-if="!['SUCCEEDED','FAILED','EXPIRED'].includes(activeTopUp.status)" class="button primary full" type="button" @click="simulateTopUp">จำลองการชำระกับ Xendit</button>
            </template>
            <div v-else class="empty"><span>⌁</span><h3>ยังไม่มี PromptPay</h3><p>ขอราคาและยืนยันทางด้านซ้าย</p></div>
          </article>
        </section>

        <section v-else-if="activeStep === 1">
          <div class="section-grid">
            <article class="panel">
              <p class="step-number">01</p><h2>สร้างงานแบบมีเงินค้ำ</h2><p class="muted">เงินจะย้ายจากยอดใช้จ่ายไปพักไว้ในงานทันที</p>
              <form class="form" @submit.prevent="createJob">
                <label>ชื่องาน<input v-model="jobForm.title" required maxlength="200" /></label>
                <label>รายละเอียด<textarea v-model="jobForm.description" required maxlength="10000"></textarea></label>
                <div class="form-row"><label>ค่าจ้าง<input v-model.number="jobForm.job_amount" type="number" min="1" required /></label><label>ปิดสมัคร<input v-model="jobForm.application_deadline" type="datetime-local" required /></label></div>
                <label>กำหนดส่ง<input v-model="jobForm.work_deadline" type="datetime-local" required /></label>
                <button class="button primary" type="submit" :disabled="busy > 0">สร้างงานและพักเงิน</button>
              </form>
            </article>
            <article class="panel">
              <p class="step-number">02</p><h2>งานที่มองเห็น</h2><p class="muted">เลือกงาน แล้วสลับเป็นผู้ใช้ทดสอบเพื่อสมัคร</p>
              <div v-if="!jobs.length" class="empty compact">ยังไม่มีงาน</div>
              <button v-for="job in jobs" :key="job.id" type="button" class="job-row" :class="{ active: flowJob?.id === job.id }" @click="chooseJob(job)">
                <span><strong>{{ job.title }}</strong><small>{{ job.status }} · {{ job.id.slice(0, 8) }}</small></span><b>{{ money(job.job_amount) }}</b>
              </button>
            </article>
          </div>
          <article v-if="flowJob" class="panel flow-job">
            <div class="panel-heading"><div><p class="eyebrow">Selected job</p><h2>{{ flowJob.title }}</h2></div><span class="status" :class="statusTone(flowJob.status)">{{ flowJob.status }}</span></div>
            <p>{{ flowJob.description }}</p><dl class="facts"><div><dt>ค่าจ้าง</dt><dd>{{ money(flowJob.job_amount) }}</dd></div><div><dt>ผู้ทำงานได้รับ</dt><dd>{{ money(flowJob.worker_net_amount) }}</dd></div><div><dt>ส่งภายใน</dt><dd>{{ dateTime(flowJob.work_deadline) }}</dd></div></dl>
            <div v-if="flowJob.status === 'OPEN' && !isEmployer" class="inline-action"><input v-model="applicationMessage" aria-label="ข้อความสมัครงาน" /><button class="button primary" type="button" @click="applyForJob">สมัครงาน</button></div>
            <div v-if="flowJob.status === 'OPEN' && isEmployer">
              <button class="button primary" type="button" @click="loadApplications">โหลดผู้สมัคร</button>
              <div v-for="item in applications" :key="item.id" class="application-row"><span><strong>{{ findUserByIdentifier(allUsers, item.worker_user_id)?.name ?? item.worker_user_id.slice(0, 8) }}</strong><small>{{ item.message }}</small></span><button class="button secondary small" type="button" :disabled="busy > 0" @click="selectWorker(item)">เลือกเป็นผู้ทำงาน</button></div>
            </div>
          </article>
        </section>

        <section v-else-if="activeStep === 2" class="section-grid">
          <article class="panel">
            <p class="step-number">01</p><h2>ส่งงานในฐานะผู้ทำงาน</h2>
            <template v-if="flowJob">
              <p><strong>{{ flowJob.title }}</strong></p><p class="muted">สถานะ {{ flowJob.status }}</p>
              <label>สรุปงาน<textarea v-model="submissionSummary"></textarea></label>
              <button class="button primary full" type="button" :disabled="busy > 0 || !isWorker || !['ASSIGNED', 'OVERDUE'].includes(flowJob.status)" @click="submitWork">ส่งงาน</button>
              <p v-if="!flowJob.intended_payee_user_id && !flowJob.selected_worker_user_id" class="hint">ผู้สร้างงานต้องเลือกผู้สมัครก่อน จึงจะส่งงานได้</p>
              <p v-else-if="!isWorker" class="hint">สลับเป็นผู้ใช้ที่ได้รับเลือกก่อน</p>
            </template>
            <div v-else class="empty compact">เลือกงานในขั้นก่อนหน้า</div>
          </article>
          <article class="panel">
            <p class="step-number">02</p><h2>อนุมัติและจ่ายรายได้</h2>
            <template v-if="flowJob">
              <dl class="facts"><div><dt>สถานะงาน</dt><dd>{{ flowJob.status }}</dd></div><div><dt>รายได้สุทธิ</dt><dd>{{ money(flowJob.worker_net_amount) }}</dd></div></dl>
              <button class="button primary full" type="button" :disabled="!isEmployer || flowJob.status !== 'IN_REVIEW'" @click="approveWork">อนุมัติงาน</button>
              <p v-if="!isEmployer" class="hint">สลับกลับเป็นผู้สร้างงานเพื่ออนุมัติ</p>
            </template>
          </article>
        </section>

        <section v-else-if="activeStep === 3" class="section-grid">
          <article class="panel">
            <p class="step-number">01</p><h2>บัญชีรับเงิน</h2><p v-if="payoutAccount" class="saved-account">{{ payoutAccount.bank_code }} · {{ payoutAccount.masked_account_number }} · {{ payoutAccount.account_holder_name }}</p>
            <form class="form" @submit.prevent="savePayoutAccount">
              <div class="form-row"><label>ชื่อ<input v-model="accountForm.given_name" required /></label><label>นามสกุล<input v-model="accountForm.surname" required /></label></div>
              <label>ชื่อบัญชี<input v-model="accountForm.account_holder_name" required /></label>
              <div class="form-row"><label>ธนาคาร<select v-model="accountForm.bank_code"><option>BBL</option><option>KBANK</option><option>SCB</option><option>KTB</option><option>BAY</option><option>TTB</option></select></label><label>เลขบัญชี<input v-model="accountForm.account_number" required inputmode="numeric" /></label></div>
              <button class="button secondary" type="submit">บันทึกบัญชี</button>
            </form>
          </article>
          <article class="panel">
            <p class="step-number">02</p><h2>ถอนผ่าน Xendit</h2><p class="muted">ถอนจากกระเป๋ารายได้ของผู้ทำงานเท่านั้น</p>
            <form class="form" @submit.prevent="quotePayout"><label>จำนวนเงินที่รับ<input v-model.number="payoutAmount" type="number" min="1" required /></label><button class="button primary" type="submit" :disabled="!payoutAccount">ขอราคาถอน</button></form>
            <div v-if="payoutQuote" class="quote"><div><span>ผู้ใช้ได้รับ</span><strong>{{ money(payoutQuote.receipt_baht) }}</strong></div><div class="total"><span>สำรองสูงสุด</span><strong>{{ money(payoutQuote.maximum_debit_baht) }}</strong></div><button class="button primary full" type="button" @click="createPayout">ยืนยันถอน</button></div>
            <div v-if="activePayout" class="payout-result"><span class="status" :class="statusTone(activePayout.status)">{{ activePayout.status }}</span><strong>{{ money(activePayout.principal_baht) }}</strong><small>{{ activePayout.reference }}</small></div>
          </article>
        </section>

        <section v-else class="panel">
          <div class="panel-heading"><div><p class="eyebrow">Wallet history</p><h2>กิจกรรมทางการเงิน</h2></div><button class="button secondary small" type="button" @click="refreshAll">รีเฟรช</button></div>
          <div v-if="!activities.length" class="empty">ยังไม่มีกิจกรรม</div>
          <div v-for="item in activities" :key="item.id" class="activity-row">
            <span class="activity-icon">{{ item.type === 'TOP_UP' ? '+' : item.type === 'PAYOUT' ? '↗' : '฿' }}</span>
            <span><strong>{{ item.title }}</strong><small>{{ item.type }} · {{ item.status }} · {{ dateTime(item.occurred_at) }}</small></span>
            <div><b v-if="item.spending_delta">{{ item.spending_delta > 0 ? '+' : '' }}{{ money(item.spending_delta) }}</b><b v-if="item.earnings_delta">{{ item.earnings_delta > 0 ? '+' : '' }}{{ money(item.earnings_delta) }}</b></div>
          </div>
        </section>
      </main>
    </div>
    <DebugPanel :open="debugOpen" :logs="logs" :diagnostics="diagnostics" @close="debugOpen = false" @clear="logs = []" />
  </div>
</template>
