import { panel, heading, body } from "./_components/styles";

// /portal with no firm: deliberately says nothing about which firms use this
// service (no list, no search). Clients arrive through their firm's link.

export default function PortalIndex() {
  return (
    <section className={panel}>
      <h1 className={heading}>Secure portal</h1>
      <p className={`mt-3 ${body}`}>Please use the sign-in link your legal team gave you.</p>
    </section>
  );
}
