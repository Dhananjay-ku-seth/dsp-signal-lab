import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { useAuth } from "./useAuth";

export function useProfile() {
  const { user } = useAuth();
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!user) {
      setIsPro(false);
      setLoading(false);
      return false;
    }
    const { data } = await supabase
      .from("profiles")
      .select("is_pro")
      .eq("user_id", user.id)
      .maybeSingle();
    const pro = data?.is_pro ?? false;
    setIsPro(pro);
    setLoading(false);
    return pro;
  }, [user?.id]);

  useEffect(() => {
    setLoading(true);
    refetch();
  }, [refetch]);

  return { isPro, loading, refetch };
}
