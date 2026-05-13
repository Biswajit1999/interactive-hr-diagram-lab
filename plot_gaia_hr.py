#!/Biswajit Jana 2026/bin/env python3
"""
Gaia DR3 H–R Diagram Plotter

Code by Biswajit 

This script lets someone download a Gaia CSV file and reproduce a clean
Hertzsprung–Russell diagram locally.

Expected CSV columns:
    source_id, ra, dec, parallax, bp_rp, phot_g_mean_mag

Example:
    python python/plot_gaia_hr.py data/gaia_sample.csv

Optional:
    python python/plot_gaia_hr.py data/gaia_sample.csv --style classic
    python python/plot_gaia_hr.py data/gaia_sample.csv --out outputs/my_hr_plot.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt


SUN_BP_RP = 0.82
SUN_MG = 4.67


def clean_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Make column names lowercase and easier to handle."""
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    return df


def validate_columns(df: pd.DataFrame) -> None:
    required = {"parallax", "bp_rp", "phot_g_mean_mag"}
    missing = required.difference(df.columns)

    if missing:
        raise ValueError(
            "Missing required Gaia columns: "
            + ", ".join(sorted(missing))
            + "\nExpected at least: parallax, bp_rp, phot_g_mean_mag"
        )


def prepare_gaia_data(df: pd.DataFrame) -> pd.DataFrame:
    """
    Convert Gaia apparent G magnitude and parallax into absolute G magnitude.

    distance_pc = 1000 / parallax_mas
    M_G = G + 5 + 5 log10(parallax_mas / 1000)
    """
    df = clean_columns(df)
    validate_columns(df)

    numeric_cols = ["parallax", "bp_rp", "phot_g_mean_mag"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.dropna(subset=numeric_cols)

    # Keep physically useful parallaxes only.
    df = df[df["parallax"] > 0].copy()

    df["distance_pc"] = 1000.0 / df["parallax"]
    df["M_G"] = df["phot_g_mean_mag"] + 5.0 + 5.0 * np.log10(df["parallax"] / 1000.0)

    # Approximate luminosity relative to the Sun using Gaia G-band absolute magnitude.
    df["luminosity_solar_approx"] = 10 ** ((SUN_MG - df["M_G"]) / 2.5)

    # Keep a sensible plot range.
    df = df[
        (df["bp_rp"] > -0.8)
        & (df["bp_rp"] < 5.0)
        & (df["M_G"] > -10)
        & (df["M_G"] < 18)
    ].copy()

    return df


def colour_values(df: pd.DataFrame, style: str):
    """
    Return colour values for plotting.

    gaia:
        continuous BP-RP colour using a warm/cool colormap
    classic:
        textbook-like blue-to-red mapping
    mono:
        single scientific cyan-white tone
    """
    if style == "mono":
        return "#dff7ff"

    return df["bp_rp"]


def draw_region_labels(ax: plt.Axes) -> None:
    """Add simple region labels for educational interpretation."""
    ax.text(0.25, 8.2, "Main sequence", color="#35f2d0", fontsize=10, alpha=0.85)
    ax.text(1.55, 0.5, "Red giants", color="#ff8a3d", fontsize=10, alpha=0.85)
    ax.text(1.45, -5.0, "Supergiants", color="#ff4df0", fontsize=10, alpha=0.80)
    ax.text(0.10, 13.0, "White dwarfs", color="#6ea8ff", fontsize=10, alpha=0.85)


def draw_sun_marker(ax: plt.Axes) -> None:
    """Plot the Sun at its approximate Gaia colour and absolute magnitude."""
    ax.scatter(
        [SUN_BP_RP],
        [SUN_MG],
        s=120,
        marker="*",
        facecolor="#ffd84d",
        edgecolor="black",
        linewidth=0.8,
        zorder=10,
        label="Sun",
    )

    ax.annotate(
        "☉ Sun\nG2V · 5772 K\nBP–RP ≈ 0.82\nM$_G$ ≈ 4.67",
        xy=(SUN_BP_RP, SUN_MG),
        xytext=(SUN_BP_RP + 0.25, SUN_MG - 1.3),
        fontsize=9,
        color="#ffe27a",
        arrowprops=dict(arrowstyle="->", color="#ffe27a", lw=1.0),
        bbox=dict(boxstyle="round,pad=0.35", fc="#101827", ec="#ffe27a", alpha=0.88),
    )


def plot_hr_diagram(df: pd.DataFrame, output: Path, style: str = "gaia") -> None:
    plt.figure(figsize=(10, 8), dpi=180)
    ax = plt.gca()

    ax.set_facecolor("#020408")
    plt.gcf().patch.set_facecolor("#020408")

    colours = colour_values(df, style)

    if style == "mono":
        ax.scatter(
            df["bp_rp"],
            df["M_G"],
            s=1.8,
            c=colours,
            alpha=0.35,
            linewidths=0,
        )
    else:
        cmap = "turbo" if style == "gaia" else "coolwarm"
        scatter = ax.scatter(
            df["bp_rp"],
            df["M_G"],
            s=1.8,
            c=colours,
            cmap=cmap,
            alpha=0.45,
            linewidths=0,
            vmin=-0.5,
            vmax=4.0,
        )

        cbar = plt.colorbar(scatter, ax=ax, pad=0.02)
        cbar.set_label("BP–RP colour index", color="white")
        cbar.ax.yaxis.set_tick_params(color="white")
        plt.setp(cbar.ax.get_yticklabels(), color="white")

    draw_region_labels(ax)
    draw_sun_marker(ax)

    ax.set_title(
        f"Gaia DR3 Hertzsprung–Russell Diagram\n{len(df):,} real catalogue stars",
        color="white",
        fontsize=15,
        pad=16,
        weight="bold",
    )

    ax.set_xlabel("BP–RP colour index  → cooler stars", color="white", fontsize=12)
    ax.set_ylabel("Absolute Gaia G magnitude  $M_G$", color="white", fontsize=12)

    # In astronomy, brighter absolute magnitudes are smaller numbers,
    # so the y-axis must be inverted.
    ax.set_xlim(-0.6, 4.3)
    ax.set_ylim(16, -8)

    ax.grid(color="white", alpha=0.08, linewidth=0.7)
    ax.tick_params(colors="white")

    for spine in ax.spines.values():
        spine.set_color((1, 1, 1, 0.35))

    output.parent.mkdir(parents=True, exist_ok=True)
    plt.tight_layout()
    plt.savefig(output, facecolor=plt.gcf().get_facecolor(), bbox_inches="tight")
    plt.close()


def plot_local_projection(df: pd.DataFrame, output: Path) -> None:
    """
    Optional simple local Cartesian projection from RA, Dec, and parallax.
    This is not a full Milky Way simulation, but it is useful for showing
    local Gaia geometry.
    """
    needed = {"ra", "dec", "distance_pc"}
    if not needed.issubset(df.columns):
        print("Skipping local projection: CSV does not contain RA/Dec columns.")
        return

    ra = np.deg2rad(pd.to_numeric(df["ra"], errors="coerce"))
    dec = np.deg2rad(pd.to_numeric(df["dec"], errors="coerce"))
    d = pd.to_numeric(df["distance_pc"], errors="coerce")

    x = d * np.cos(dec) * np.cos(ra)
    y = d * np.cos(dec) * np.sin(ra)

    plt.figure(figsize=(8, 8), dpi=180)
    ax = plt.gca()
    ax.set_facecolor("#020408")
    plt.gcf().patch.set_facecolor("#020408")

    ax.scatter(x, y, s=1.2, c=df["bp_rp"], cmap="turbo", alpha=0.35, linewidths=0)

    ax.scatter([0], [0], marker="*", s=120, color="#ffd84d", edgecolor="black", label="Sun")

    ax.set_title("Local Gaia DR3 Point-Cloud Projection", color="white", fontsize=14, weight="bold")
    ax.set_xlabel("x [pc]", color="white")
    ax.set_ylabel("y [pc]", color="white")
    ax.grid(color="white", alpha=0.08)
    ax.tick_params(colors="white")
    ax.set_aspect("equal", adjustable="box")

    for spine in ax.spines.values():
        spine.set_color((1, 1, 1, 0.35))

    output.parent.mkdir(parents=True, exist_ok=True)
    plt.tight_layout()
    plt.savefig(output, facecolor=plt.gcf().get_facecolor(), bbox_inches="tight")
    plt.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot a Gaia DR3 H–R diagram from a CSV file.")
    parser.add_argument(
        "csv_file",
        type=Path,
        help="Path to Gaia CSV file, e.g. data/gaia_sample.csv",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("outputs/gaia_hr_diagram.png"),
        help="Output plot path. Default: outputs/gaia_hr_diagram.png",
    )
    parser.add_argument(
        "--style",
        choices=["gaia", "classic", "mono"],
        default="gaia",
        help="Colour style for the H–R diagram.",
    )
    parser.add_argument(
        "--projection",
        action="store_true",
        help="Also save a simple local x-y projection plot.",
    )

    args = parser.parse_args()

    if not args.csv_file.exists():
        raise FileNotFoundError(f"CSV file not found: {args.csv_file}")

    print(f"Reading Gaia CSV: {args.csv_file}")
    raw = pd.read_csv(args.csv_file)

    print("Preparing Gaia data...")
    df = prepare_gaia_data(raw)

    print(f"Accepted stars after cleaning: {len(df):,}")
    print(f"Saving H–R diagram to: {args.out}")

    plot_hr_diagram(df, args.out, style=args.style)

    if args.projection:
        projection_out = args.out.with_name(args.out.stem + "_local_projection.png")
        print(f"Saving local projection to: {projection_out}")
        plot_local_projection(df, projection_out)

    print("Done.")


if __name__ == "__main__":
    main()
