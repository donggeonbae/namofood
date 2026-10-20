// Shinhan credentials are read only on the server; never return provider bodies.
type Dependencies = {
  env: (name: string) => string;
  fetch: typeof fetch;
};
const secrets = ['BANKAPI_API_KEY', 'BANKAPI_SECRET_KEY', 'BANKAPI_SH_LOGIN_ID',
  'BANKAPI_SH_LOGIN_PASSWORD', 'BANKAPI_SH_ACCOUNT_NUMBER', 'BANKAPI_SH_ACCOUNT_PASSWORD'];
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export async function bankTransactions(
  body: Record<string, unknown>, admin: boolean, deps: Dependencies,
) {
  const result = (data: Record<string, unknown>, status = 200) => ({data, status});
  if (!admin) return result({error: '관리자 로그인이 필요합니다.'}, 403);
  if (!validDate(body.startDate) || !validDate(body.endDate) || body.startDate > body.endDate) {
    return result({error: '조회 시작일과 종료일을 확인해 주세요.'}, 400);
  }
  if (Date.parse(body.endDate) - Date.parse(body.startDate) > 92 * 86400000) {
    return result({error: '한 번에 최대 93일을 조회할 수 있습니다.'}, 400);
  }
  const values = secrets.map(deps.env);
  if (values.some(value => !value)) return result({error: '신한 계좌 조회 설정이 필요합니다. 관리자에게 인증정보 등록을 요청해 주세요.', code: 'bank_not_configured'}, 503);
  const [key, secret, loginId, loginPassword, accountNumber, accountPassword] = values;
  try {
    const response = await deps.fetch('https://api.bankapi.co.kr/v1/transactions/login', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}:${secret}`},
      body: JSON.stringify({bankCode: 'SH', loginId, loginPassword,
        accounts: [{accountNumber, accountPassword}],
        startDate: body.startDate.replaceAll('-', ''), endDate: body.endDate.replaceAll('-', ''), sortOrder: 'recent'}),
    });
    // Bound the body before parsing; do not log bank responses or credentials.
    const reader = response.body?.getReader();
    if (!reader) throw Error('empty');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) {await reader.cancel(); throw Error('size');}
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const account = Array.isArray(data.results) ? data.results.find((r: {accountNumber?: string}) => r.accountNumber === accountNumber) : null;
    const retryAfterSec = Math.min(3600, Math.max(300, Number(data.retryAfterSec) || 300));
    if (response.status === 429 || account?.code === 'ACCOUNT_COOLDOWN') return result({error: '재조회 대기시간이 남아 있습니다.', retryAfterSec}, 429);
    if (!response.ok || data.success !== true || account?.success !== true || !Array.isArray(account.transactions)) {
      const message = response.status === 401 ? 'BankAPI 키 인증을 확인해 주세요.' : response.status === 403 ? '계좌 조회 서버의 국내 IP 설정을 확인해 주세요.' : '신한 조회에 실패했습니다. 인터넷뱅킹 로그인과 간편계좌 등록을 확인해 주세요.';
      return result({error: message, retryAfterSec: 300}, 502);
    }
    const transactions = await Promise.all(account.transactions.map(async (row: Record<string, unknown>) => {
      if (!row || !['deposit', 'withdrawal'].includes(String(row.type)) || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || typeof row.balance !== 'number' || !Number.isFinite(row.balance)) throw Error('row');
      const clean: Record<string, unknown> = {type: row.type, amount: row.amount, balance: row.balance};
      for (const field of ['date', 'time', 'description', 'displayName', 'counterparty', 'branch', 'memo']) clean[field] = typeof row[field] === 'string' ? row[field].slice(0, 300) : '';
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountNumber + '\n' + JSON.stringify(clean)));
      clean.id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      return clean;
    }));
    return result({transactions, fetchedAt: new Date().toISOString(), retryAfterSec: 300});
  } catch {
    return result({error: '계좌 조회 응답을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.', retryAfterSec: 300}, 502);
  }
}
