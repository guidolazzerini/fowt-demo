"""Build the short user guide with the locally available matplotlib.

Run: py -3.13 scripts/create-user-guide.py
Writes the PDF to docs/ and inspection PNGs to ignored .guide-preview.local/.
This documentation utility adds no dependency to the browser application.
"""
from pathlib import Path
import textwrap

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import Rectangle

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "fowt-user-checks.pdf"
PREVIEW = ROOT / ".guide-preview.local"
PREVIEW.mkdir(exist_ok=True)
plt.rcParams.update({"font.family": "DejaVu Sans", "pdf.fonttype": 42})
INK, MUTED, TEAL, BLUE = "#173348", "#526778", "#087f8c", "#edf5f8"
PAGE_W, PAGE_H = 595.28, 841.89  # A4, points


class Page:
    def __init__(self, number, title, subtitle):
        self.figure = plt.figure(figsize=(PAGE_W / 72, PAGE_H / 72), facecolor="white")
        self.ax = self.figure.add_axes([0, 0, 1, 1])
        self.ax.set(xlim=(0, PAGE_W), ylim=(PAGE_H, 0))
        self.ax.axis("off")
        self.artists = []
        self.text(42, 30, "FLOATING WIND LAB  /  IEA 15 MW DEMONSTRATOR", 9, TEAL, True)
        self.text(42, 57, title, 24, INK, True)
        self.text(42, 94, subtitle, 10, MUTED)
        self.ax.plot([42, 553], [121, 121], color=TEAL, lw=2)
        self.y = 140
        self.ax.plot([42, 553], [796, 796], color="#dbe5e9", lw=1)
        self.text(42, 807, "USER CHECKS  ·  20 s torque averaging  ·  October 2026", 8, MUTED)
        self.text(521, 807, f"{number} / 3", 8, MUTED)

    def text(self, x, y, value, size=10.5, color=INK, bold=False, url=None):
        artist = self.ax.text(x, y, value, fontsize=size, color=color,
                              fontweight="bold" if bold else "normal", va="top", url=url)
        self.artists.append(artist)

    def paragraph(self, value, color=INK, size=10.5, width=91, gap=9):
        lines = textwrap.wrap(value, width=width, break_long_words=False, break_on_hyphens=False)
        for line in lines:
            self.text(42, self.y, line, size, color)
            self.y += 14.5
        self.y += gap

    def section(self, number, title):
        self.y += 4
        self.text(42, self.y, number, 12, TEAL, True)
        self.text(68, self.y, title, 12, INK, True)
        self.y += 25

    def result(self, value):
        self.paragraph("LOOK FOR  " + value, color=TEAL, size=10, width=95, gap=12)

    def band(self, value):
        lines = textwrap.wrap(value, width=86, break_long_words=False)
        height = len(lines) * 14.5 + 18
        self.ax.add_patch(Rectangle((42, self.y - 5), 511, height, color=BLUE, zorder=-1))
        for line in lines:
            self.text(52, self.y + 3, line, 10, INK)
            self.y += 14.5
        self.y += 24

    def save(self, pdf, number):
        # Validate layout against the rendered font metrics, not character count.
        self.figure.canvas.draw()
        renderer = self.figure.canvas.get_renderer()
        for artist in self.artists:
            extent = artist.get_window_extent(renderer).transformed(self.ax.transData.inverted())
            assert extent.x0 >= 35 and extent.x1 <= 560, (number, artist.get_text(), "horizontal overflow")
            assert extent.y0 >= 20 and extent.y1 <= 829, (number, artist.get_text(), "vertical overflow")
        assert self.y < 780, (number, self.y, "body overlaps footer")
        pdf.savefig(self.figure)
        self.figure.savefig(PREVIEW / f"page-{number}.png", dpi=130)
        plt.close(self.figure)


with PdfPages(OUTPUT, metadata={"Title": "Floating Wind Lab - User checks and experiments",
                               "Author": "Floating Wind Lab", "Subject": "Browser review before deployment"}) as pdf:
    page = Page(1, "Start here", "A short hands-on review for students and first-time users.")
    page.band("Use the simulator link supplied with this guide. Local review: http://127.0.0.1:4174/ (requires the local server). Times are simulated seconds unless marked REAL minutes.")
    page.section("01", "Set up a repeatable baseline")
    page.paragraph("Control strategy: select Coordinated TSR PI. Enable set-point smoothing and Simple startup / shutdown. In Gains, select Fixed reference · pitch 0.60 / 0.015, then click Apply SUGGESTED gains.")
    page.paragraph("Confirm floating feedback is off. In Limits and initialization, use minimum pitch 0°, maximum 30° and pitch rate 5°/s. In Environment, choose Constant wind at 8 m/s. Press Enter to apply numeric edits.")
    page.paragraph("Click Reset, then Show diagnostics. Expect time 0, rotor speed 0 rpm, pitch 90° and generator torque 0. After the clock starts, torque averages should say 20 s mean.")
    page.section("02", "Start, pause and resume")
    page.paragraph("Click Start turbine. Watch Waiting → free-wheel → load ramp → generating. At 8 m/s with the reference gains, generation starts around 97 s, including the initial 20 s assessment. Allow another 60 s to settle.")
    page.paragraph("Click Stop, wait a few real seconds, then Start. Switch settings tabs and open or close help while running.")
    page.result("Stop freezes time; Start resumes the same run. Tabs and help preserve the simulation. Speed tracks its reference and generator torque becomes positive.")
    page.section("03", "Ride through a lull, then stop and restart")
    page.paragraph("From settled 8 m/s operation, set Constant wind to 0 m/s for 10 simulated seconds; restore 8 m/s and allow 120 s to recover. The turbine should keep generating through the short lull.")
    page.paragraph("Set wind to 0 m/s again and leave it there. Watch the actual torque mean fall below 0.040 MN m. Shutdown should begin within about 20 s for this case, then feather and coast to rest. Full stopping takes longer.")
    page.result("Parked means 0 rpm, 90° pitch and zero generator torque. Restore 8 m/s: restart requires Start turbine; simulation time should continue.")
    page.save(pdf, 1)

    page = Page(2, "Check stability", "Use the fixed reference gains throughout these checks.")
    page.section("04", "Below-rated turbulence")
    page.paragraph("Choose Random wind, mean 5 m/s and turbulence intensity 0.12 (12%). Reset → Start turbine. After generation begins, run for 300 s. Repeat at mean 3.2 m/s; startup may take several simulated minutes.")
    page.result("Brief wind dips below 3 m/s do not themselves trigger shutdown. Speed may dip below its 5 rpm minimum reference. Look for finite, bounded responses and no continuously growing oscillations. Record any shutdown reason and torque mean.")
    page.section("05", "Above-rated control and live gains")
    page.paragraph("Choose Constant wind at 18 m/s. Reapply the Fixed reference gains, then Reset → Start turbine. Run for 300 s after generation starts. Expect speed near 7.55 rpm and torque near its 18.97 MN m operating cap.")
    page.paragraph("Switch to Random wind at 18 m/s, intensity 0.12; run another 300 s. Change Pitch Kp from 0.60 to 0.70, wait 60 s, then Pitch Ki from 0.015 to 0.020. Wait 60 s and reapply the Fixed reference gains.")
    page.result("Time and wind continue without Reset. Pitch reacts within its rate limit. Gains stay at your chosen values when wind or operating region changes.")
    page.section("06", "Chrome memory and responsiveness")
    page.paragraph("Set Random wind at 8 m/s, intensity 0.12, with reference gains. Reset → Start turbine. Keep Controller diagnostics expanded and the simulator tab visible for 20 REAL minutes; do not Reset or reload.")
    page.paragraph("Press Shift+Esc for Chrome Task Manager. Find the simulator tab; right-click the column headings to enable JavaScript memory if available. Record the tab's Memory footprint and JavaScript memory at the times below. Note the worker separately if listed.")
    page.band("REAL minutes          2             5             10             15             20\nMemory notes: record readings and units in your own notes.")
    page.result("Memory should broadly settle after warming up; rises followed by drops can be normal. Continuous growth, frozen controls or a crash needs investigation. Finish by toggling diagnostics and testing Stop → Start.")
    page.paragraph("Chrome Task Manager reference: developer.chrome.com/docs/devtools/memory-problems", size=8.5, width=107, gap=0)
    page.save(pdf, 2)

    page = Page(3, "Try a few experiments", "Optional comparisons that show what the demonstrator can do.")
    page.band("For the comparisons below: use Coordinated TSR PI, turn Simple startup / shutdown OFF, then Reset → Start. This starts at a generating equilibrium. Keep all other settings identical between paired runs.")
    page.section("A", "See the transition between torque and pitch control")
    page.paragraph("Apply Fixed reference gains. Set Gust wind: mean 10.5 m/s, amplitude +2 m/s, start 30 s, duration 80 s. Run from Reset to 150 s with smoothing ON. Repeat from Reset with smoothing OFF.")
    page.result("Compare rotor speed, the two controller references, pitch, generator torque and smoothing offset. Reset repeats the disturbance. Look for changes in transition behavior; smoothing need not improve every metric.")
    page.section("B", "Explore floating feedback")
    page.paragraph("Enable smoothing. Set Random wind at 12 m/s, intensity 0.06. In Gains, choose SUGGESTED at 12 m/s and click Apply. Set Pitch-rate gain to 10 s. Run 300 s with feedback OFF, then repeat from Reset with feedback ON.")
    page.result("Compare platform pitch and rotor-speed variation. In Plot options, enable Show 30 s average and standard deviation; compare at the same simulation time. Feedback changes the coupled response, not just rotor speed.")
    page.section("C", "Separate aerodynamic and generator power")
    page.paragraph("Compare the two power traces during the gust. Open All values and 30 s statistics for values, and Controller diagnostics for torque and saturation indicators.")
    page.result("Power traces can separate during acceleration. Generator mechanical power is rotor-side torque × rotor speed, not electrical output. A saturation indicator means a controller demand reached a limit.")
    page.section("✓", "Send back a short review")
    page.paragraph("For checks 01–06, record Pass / Issue / Not tried. For an issue, include the simulation time, exact message, wind settings, gains and whether diagnostics were expanded. Add the five memory readings and one useful screenshot if possible.")
    page.band("Model scope: educational rotor dynamics plus one platform-pitch degree of freedom. Startup/feather aerodynamics are approximate. Torque thresholds are teaching choices. Storm protection uses 100 s filtered wind; above 30 m/s exceeds the transient model. Gains are always user-selected.")
    page.save(pdf, 3)

print(f"Created {OUTPUT} ({OUTPUT.stat().st_size:,} bytes), 3 pages; previews: {PREVIEW}")
