import { useEffect, useState } from "react";
import { getServerStatus } from "./api";

export default function App() {
  const [serverStatus, setServerStatus] = useState<
    "Online" | "Offline" | "Unknown"
  >("Unknown");

  useEffect(() => {
    let mounted = true;

    async function checkStatus() {
      const status = await getServerStatus();
      if (mounted) setServerStatus(status);
    }

    checkStatus();
    const id = window.setInterval(checkStatus,5000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className={`server-status ${serverStatus}`}>
        <span className="status-dot" />
        <span>Server Status: {serverStatus}</span>
      </div>
    </div>
  );
}
