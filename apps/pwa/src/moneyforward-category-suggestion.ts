import { getAiAccessToken } from './ai-auth';

export type MoneyForwardCategoryOption = { id: string; name: string };

/** Suggests a local household-budget category for one MoneyForward category name. */
export async function suggestMoneyForwardCategory(
  sourceCategoryName: string,
  categories: MoneyForwardCategoryOption[],
): Promise<{ categoryId: string | null }> {
  try {
    const token = await getAiAccessToken();
    const response = await fetch('/api/ai/category-suggestion', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ flowId: crypto.randomUUID(), sourceCategoryName, categories }),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const code = body !== null && typeof body === 'object' && !Array.isArray(body) && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error : '';
      if (response.status === 429 && code === 'ai_quota_exceeded') throw new Error('今月のAI利用上限に達しました。');
      if (response.status === 429) throw new Error('AIの利用が集中しています。しばらく待ってからもう一度お試しください。');
      throw new Error('カテゴリ候補を取得できませんでした。通信状態を確認して、もう一度お試しください。');
    }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new Error('カテゴリ候補を受け取れませんでした。もう一度お試しください。'); }
    if (result === null || typeof result !== 'object' || Array.isArray(result) ||
        !Object.hasOwn(result, 'categoryId') ||
        !((result as { categoryId: unknown }).categoryId === null || typeof (result as { categoryId: unknown }).categoryId === 'string')) {
      throw new Error('カテゴリ候補を受け取れませんでした。もう一度お試しください。');
    }
    const categoryId = (result as { categoryId: string | null }).categoryId;
    if (categoryId !== null && !categories.some(category => category.id === categoryId)) {
      throw new Error('カテゴリ候補を受け取れませんでした。もう一度お試しください。');
    }
    return { categoryId };
  } catch (error) {
    if (error instanceof Error && ['ai_quota_exceeded', 'guest_limit_reached'].includes(error.message)) {
      throw new Error('AIの利用上限に達しました。');
    }
    if (error instanceof Error && error.message === 'rate_limited') {
      throw new Error('AIの利用が集中しています。しばらく待ってからもう一度お試しください。');
    }
    if (error instanceof Error && /^(今月のAI利用上限|AIの利用が集中|カテゴリ候補を取得できません|カテゴリ候補を受け取れません)/.test(error.message)) throw error;
    throw new Error('通信に失敗しました。通信状態を確認して、もう一度お試しください。');
  }
}
