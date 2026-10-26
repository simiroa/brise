export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        display: "inline-block",
      }}
    />
  );
}
