/** 個人清單專用的 16px 線條圖示（core Icon 尚無書籤 / 把手 / 鉛筆） */

function Svg({ d, fill = 'none' }: { d: string; fill?: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export function BookmarkIcon({ filled }: { filled: boolean }) {
  return <Svg d="M6 3h12v18l-6-4-6 4z" fill={filled ? 'currentColor' : 'none'} />;
}

export function GripIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <circle cx={9} cy={y} r={1.5} />
          <circle cx={15} cy={y} r={1.5} />
        </g>
      ))}
    </svg>
  );
}

export function PencilIcon() {
  return <Svg d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />;
}
