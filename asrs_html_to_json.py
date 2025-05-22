"""
asrs_html_to_json.py

Extracts structured data from an ASRS printable-view HTML (or any similarly
structured file that uses <p class="acnheading">, <p class="acnsection">,
and <p class="acndata"> tags) and writes the results to a JSON file.

Usage
-----
    python asrs_html_to_json.py input_file.html [output_file.json]

If *output_file* is omitted, a file with the same basename as *input_file*
and the extension `.json` is written alongside it.

The output structure is a list of records; each record is a dictionary
keyed by the section names appearing in the HTML (e.g. "Time / Day",
"Place").  Within each section:

    * Lines that match `LABEL : value` are stored as key/value pairs.
    * Narrative or free-text lines are concatenated under a `"text"` key.

No field names are hard-coded—the script simply follows the HTML’s
class markers—so it’s flexible for any “printable” ASRS result page
(or anything that re-uses those classes).
"""
import sys
import json
import pathlib
from bs4 import BeautifulSoup


def _parse_acndata_block(tag):
    """Return a list of cleaned text lines from a <p class="acndata"> tag."""
    raw_lines = tag.decode_contents().split("<br>")
    return [
        BeautifulSoup(line, "html.parser").get_text(" ", strip=True)
        for line in raw_lines
        if line.strip()
    ]


def _extract_records(soup):
    records = []
    for heading in soup.find_all("p", class_="acnheading"):
        record = {}

        # Example heading text: "ACN: 2184152 (1 of 91)"
        acn_text = heading.get_text(" ", strip=True)
        if ":" in acn_text:
            record["ACN"] = acn_text.split(":", 1)[1].split()[0]

        section_name = None
        for sib in heading.find_next_siblings("p"):
            cls = sib.get("class", [])
            if "acnheading" in cls:
                break  # Reached next record

            if "acnsection" in cls:
                section_name = sib.get_text(" ", strip=True).rstrip(":")
                record[section_name] = {}
            elif "acndata" in cls and section_name:
                lines = _parse_acndata_block(sib)
                for line in lines:
                    if " : " in line:
                        key, val = map(str.strip, line.split(" : ", 1))
                        # Preserve duplicates as lists
                        if key in record[section_name]:
                            prev = record[section_name][key]
                            record[section_name][key] = (
                                prev + [val] if isinstance(prev, list) else [prev, val]
                            )
                        else:
                            record[section_name][key] = val
                    else:  # Narrative / free text
                        record[section_name].setdefault("text", []).append(line)

        # Flatten narrative lists into single strings
        for sec in record.values():
            if isinstance(sec, dict) and "text" in sec:
                sec["text"] = "\n".join(sec["text"])

        records.append(record)
    return records


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python asrs_html_to_json.py QueryWizard_DisplayPrintable.html output_file.json")
        sys.exit(1)

    in_path = pathlib.Path(sys.argv[1])
    out_path = (
        pathlib.Path(sys.argv[2])
        if len(sys.argv) >= 3
        else in_path.with_suffix(".json")
    )

    with in_path.open("r", encoding="utf-8", errors="ignore") as f:
        soup = BeautifulSoup(f, "html.parser")

    data = _extract_records(soup)

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    print(f"Wrote {len(data)} record(s) to {out_path}")


if __name__ == "__main__":
    main()
