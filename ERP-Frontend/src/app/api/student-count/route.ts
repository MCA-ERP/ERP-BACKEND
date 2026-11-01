import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!accessToken) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "Supabase URL or anon key is not configured on the server." },
      { status: 500 },
    );
  }

  if (!serviceRoleKey) {
    return NextResponse.json(
      { error: "Configure SUPABASE_SERVICE_ROLE_KEY on the server to count all students." },
      { status: 503 },
    );
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: authError } = await authClient.auth.getUser(accessToken);

  if (authError || !userData.user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { count, error } = await adminClient
    .schema("public")
    .from("students")
    .select("*", { count: "exact", head: true });

  if (error) {
    console.error("Failed to fetch public.students count:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch student count from Supabase." },
      { status: 500 },
    );
  }

  if (count === null) {
    return NextResponse.json(
      { error: "Supabase did not return a student count." },
      { status: 500 },
    );
  }

  return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
}
