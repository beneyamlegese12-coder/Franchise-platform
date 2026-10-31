import { useState } from "react";

export function Brand({ small }: { small?: boolean }) {
  const [hasLogo, setHasLogo] = useState(true);
  return (
    <div className={"brand" + (small ? " sm" : "")}>
      {hasLogo && <img src="/logo.png" alt="" className="brand-logo" onError={() => setHasLogo(false)} />}
      <div className="brand-text">
        <div className="brand-mika">MIK<span>A</span></div>
        <div className="brand-games"><i />GAMES<i /></div>
        {!small && <div className="brand-tag">PLAY &bull; BET &bull; WIN</div>}
      </div>
    </div>
  );
}