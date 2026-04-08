import beachHomesTexture from "@/assets/images/beach-homes.jpg";
import savingsTableRows from "@/data/home-savings-table.json";

type HomeSavingsRow = {
  area: string;
  bedrooms: string;
  sleeps: number;
  vrboTotal: number;
  ourTotal: number;
};

const SAMPLE_ROWS: HomeSavingsRow[] = savingsTableRows;

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const SAVINGS_VALUE_SIZE = "text-xl md:text-2xl";

export function HomeSavingsSection() {
  return (
    <section className="relative overflow-hidden bg-white px-6 py-24">
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${beachHomesTexture})`,
          backgroundPosition: "center center",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{ backgroundColor: "rgba(255,255,255,0.62)" }}
      />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="mb-10 text-center">
          <h3
            className="text-4xl leading-tight tracking-tight text-slate-900 md:text-6xl"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Same{" "}
            <span
              className="text-[#2DD4BF]"
              style={{ textShadow: "1px 2px 0 rgba(13,148,136,0.6)" }}
            >
              Beach.
            </span>{" "}
            Same{" "}
            <span
              className="text-[#2DD4BF]"
              style={{ textShadow: "1px 2px 0 rgba(13,148,136,0.6)" }}
            >
              House.
            </span>
            <br />
            <span>Spend on Memories, Not Markups.</span>
          </h3>
          <p className="mx-auto mt-5 max-w-3xl text-lg text-slate-600 md:text-xl">
            Compare real stay totals across top 30A areas and see what you may
            save.
          </p>
        </div>

        <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_60px_-45px_rgba(15,23,42,0.45)]">
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-left">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="bg-slate-50">
                <tr className="text-xs font-bold tracking-[0.16em] text-slate-400 uppercase md:text-sm">
                  <th className="px-6 py-4">Vacation Rental</th>
                  <th className="px-6 py-4 text-right">VRBO</th>
                  <th className="px-6 py-4 text-right tracking-normal normal-case">
                    <span
                      className="text-2xl leading-none font-semibold text-slate-900 md:text-3xl"
                      style={{ fontFamily: "'Playfair Display', serif" }}
                    >
                      30<span className="text-[#2DD4BF]">A</span>
                    </span>
                  </th>
                  <th className="px-6 py-4 text-center" colSpan={2}>
                    <span className="inline-block translate-x-5 md:translate-x-6">
                      You Could Save
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {SAMPLE_ROWS.map((row) => {
                  const savings = row.vrboTotal - row.ourTotal;
                  const savedPct = Math.round((savings / row.vrboTotal) * 100);

                  return (
                    <tr
                      key={`${row.area}-${row.bedrooms}`}
                      className="border-t border-slate-100"
                    >
                      <td className="px-6 py-5">
                        <div className="text-lg font-semibold text-slate-900">
                          {row.area}
                        </div>
                        <div className="text-sm font-medium text-slate-400">
                          {row.bedrooms} / SLEEPS {row.sleeps}
                        </div>
                      </td>
                      <td className="px-6 py-5 text-right text-lg font-medium text-slate-700 tabular-nums">
                        {money.format(row.vrboTotal)}
                      </td>
                      <td className="px-6 py-5 text-right text-lg font-bold text-slate-900 tabular-nums">
                        {money.format(row.ourTotal)}
                      </td>
                      <td
                        className={`px-6 py-5 text-right tabular-nums ${SAVINGS_VALUE_SIZE} font-bold text-[#14B8A6]`}
                      >
                        {money.format(savings)}
                      </td>
                      <td
                        className={`px-4 py-5 text-center ${SAVINGS_VALUE_SIZE} font-medium text-[#14B8A6]/85`}
                      >
                        {savedPct}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-slate-100 px-6 py-4 text-center text-[11px] text-slate-500">
            Example comparison across similar homes and date windows. Actual
            totals vary by stay.
          </p>
        </div>
      </div>
    </section>
  );
}
