<script setup lang="ts">
defineProps<{ active: number; completed: number[] }>();
defineEmits<{ select: [index: number] }>();
const steps = ['เติมเงิน', 'สร้างงาน', 'ส่งและอนุมัติ', 'ถอนรายได้', 'กิจกรรม'];
</script>

<template>
  <nav class="flow-nav" aria-label="ขั้นตอนทดสอบการไหลของเงิน">
    <button v-for="(step, index) in steps" :key="step" type="button"
      :class="{ active: active === index, done: completed.includes(index) }" @click="$emit('select', index)">
      <span>{{ completed.includes(index) ? '✓' : index + 1 }}</span>
      {{ step }}
    </button>
  </nav>
</template>
