import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export const useUserSession = () => {
    const [searchParams] = useSearchParams();
    const [tid, setTid] = useState<string | null>(null);

    useEffect(() => {
        // 1. Tentar pegar da URL
        const urlTid = searchParams.get("tid");
        if (urlTid) {
            setTid(urlTid);
            localStorage.setItem("venux_tid", urlTid);
        } else {
            // 2. Tentar pegar do LocalStorage
            const storedTid = localStorage.getItem("venux_tid");
            if (storedTid) {
                setTid(storedTid);
            }
        }
    }, [searchParams]);

    return { tid };
};
