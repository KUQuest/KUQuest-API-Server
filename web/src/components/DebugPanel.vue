<script setup lang="ts">
import type { RequestLog } from '../api';

defineProps<{ open: boolean; logs: RequestLog[]; diagnostics: unknown }>();
defineEmits<{ close: []; clear: [] }>();
</script>

<template>
  <aside v-if="open" class="debug-panel" aria-label="รายละเอียดการเชื่อมต่อ API">
    <header>
      <div>
        <p class="eyebrow">Developer detail</p>
        <h2>API activity</h2>
      </div>
      <button class="icon-button" type="button" aria-label="ปิดรายละเอียด API" @click="$emit('close')">×</button>
    </header>
    <p class="muted">ข้อมูลอ่อนไหวถูกตัดออกก่อนแสดงผล</p>
    <div class="debug-actions">
      <button class="button secondary small" type="button" @click="$emit('clear')">ล้าง log</button>
    </div>
    <details v-if="diagnostics" class="debug-entry">
      <summary>Database diagnostics</summary>
      <pre>{{ JSON.stringify(diagnostics, null, 2) }}</pre>
    </details>
    <div v-if="!logs.length" class="empty compact">ยังไม่มี API request</div>
    <details v-for="(log, index) in logs" :key="`${log.time}-${index}`" class="debug-entry">
      <summary>
        <strong :class="log.status >= 200 && log.status < 400 ? 'ok' : 'bad'">{{ log.status || 'NET' }}</strong>
        <span>{{ log.method }} {{ log.path }}</span>
        <small>{{ log.duration_ms }}ms</small>
      </summary>
      <pre>{{ JSON.stringify(log, null, 2) }}</pre>
    </details>
  </aside>
</template>
