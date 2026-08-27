from pathlib import Path
import fitz

source = Path("attached_assets/irrigation_repairs_1787855107262.pdf")
output_dir = Path(".agents/outputs/irrigation_repairs")
output_dir.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
print("pages:", document.page_count)
print("metadata:", document.metadata)

for page_number, page in enumerate(document, start=1):
    image = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    output = output_dir / f"page-{page_number}.png"
    image.save(output)
    print(output)
    print(page.get_text())