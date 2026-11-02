/**
 * The Timeline hero's card and its money line, shared by the ordinary day's
 * cards and a trip's.
 */

import type { ReactNode } from "react";
import { money, type Money } from "../intel/everyday";

export function Amounts(props: { sums: Money[] }) {
  if (props.sums.length === 0) {
    return <div className="tln-money">none</div>;
  }
  return (
    <div className="tln-money">
      {props.sums.map((sum) => (
        <div key={sum.currency}>
          <small>{sum.currency}</small>
          <b>{money(sum).slice(sum.currency.length + 1)}</b>
        </div>
      ))}
    </div>
  );
}

export function Card(props: { title: string; aside?: ReactNode; tone?: "yes" | "dashed"; className?: string; children: ReactNode }) {
  return (
    <section className={`tln-card${props.tone ? ` tln-card-${props.tone}` : ""}${props.className ? ` ${props.className}` : ""}`}>
      <div className="tln-hd">
        {props.title}
        {props.aside !== undefined && <span className="tln-hd-aside">{props.aside}</span>}
      </div>
      {props.children}
    </section>
  );
}
