<script setup lang="ts">
defineProps<{ label: string; amount?: number; tone?: 'accent' | 'plain'; hint?: string }>();
const format = (value?: number) => value === undefined ? '—' : `${new Intl.NumberFormat('th-TH').format(value)} ฿`;
</script>

<template>
  <article class="money-card" :class="{ accent: tone === 'accent' }">
    <span>{{ label }}</span>
    <strong>{{ format(amount) }}</strong>
    <small>{{ hint }}</small>
  </article>
</template>
