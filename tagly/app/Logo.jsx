// Tagly logo mark (real asset, transparent bg). Used in every header.
export default function Logo({ size = 30 }) {
  return (
    <img
      src="/pub/tagly/tagly/logo.png"
      alt="Tagly"
      style={{ height: size, width: 'auto', display: 'block' }}
    />
  );
}
