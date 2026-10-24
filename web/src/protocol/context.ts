// v2 protocol: check-in context (one-tap questions before the scan) and what it means for the baseline.

export interface CheckContext {
  exercise: boolean;
  caffeine: boolean;
  slept_well: boolean;
  took_meds?: boolean | null; // asked only when the patient has known conditions
}

export interface ContextQuestion { key: keyof CheckContext; q: string; hint: string }

export function contextQuestions(hasConditions: boolean): ContextQuestion[] {
  const qs: ContextQuestion[] = [
    { key: 'exercise', q: 'رياضة آخر 30 دقيقة؟', hint: 'مشي سريع، درج، أو أي مجهود' },
    { key: 'caffeine', q: 'قهوة أو شاي آخر ساعة؟', hint: 'أي مشروب فيه كافيين' },
    { key: 'slept_well', q: 'نمت منيح؟', hint: 'مبارح بالليل' },
  ];
  if (hasConditions) qs.push({ key: 'took_meds', q: 'أخدت دواك اليوم؟', hint: 'الدوا اللي بتاخده كل يوم' });
  return qs;
}

/** Exercise or caffeine raise HR for a while: keep the reading (saved and shown) but out of the personal baseline. */
export function contextFields(ctx: CheckContext | null, quality: 'good' | 'fair' | 'poor'): { context?: CheckContext; excluded_from_baseline?: boolean } {
  if (!ctx) return {};
  return { context: ctx, excluded_from_baseline: ctx.exercise || ctx.caffeine || quality === 'poor' };
}

export function contextNote(ctx: CheckContext | null): string | null {
  if (!ctx) return null;
  const why = [ctx.exercise ? 'عملت رياضة' : '', ctx.caffeine ? 'شربت قهوة أو شاي' : ''].filter(Boolean).join(' و');
  return why ? `قراءتك محفوظة وبتظهر لطبيبك، بس ما رح تدخل بحساب معدلك الطبيعي لأنك ${why} قبل الفحص.` : null;
}
