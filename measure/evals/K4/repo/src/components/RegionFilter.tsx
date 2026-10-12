type GroupBy = "region" | "branch";

type Props = {
  value: GroupBy;
  onChange: (value: GroupBy) => void;
};

export function RegionFilter({ value, onChange }: Props) {
  return (
    <div>
      <button aria-pressed={value === "region"} onClick={() => onChange("region")}>Region</button>
      <button aria-pressed={value === "branch"} onClick={() => onChange("branch")}>Branch</button>
    </div>
  );
}
