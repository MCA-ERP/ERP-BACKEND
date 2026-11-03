export interface Page {
  page: number;
  pageSize: number;
  from: number;
  to: number;
}

export function parsePage(query: Record<string, unknown>): Page {
  const page = Math.max(1, parseInt(String(query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(query.pageSize ?? "20"), 10) || 20));
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

/** Strip characters that would break PostgREST `or()` filter syntax. */
export function safeSearch(raw: unknown): string {
  return String(raw ?? "").trim().replace(/[,()%*\\]/g, " ").slice(0, 80);
}
