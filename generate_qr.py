#!/usr/bin/env python3
"""Generate Pay by Square QR code for New Level Church donations."""
import binascii
import lzma
from datetime import datetime
import qrcode


def generate_pay_by_square(
    amount_str: str,
    iban: str,
    swift: str = "",
    beneficiary_name: str = "",
    currency: str = "EUR",
    note: str = "",
) -> str:
    """Generate Pay by Square data with custom amount string (can be empty)."""
    date = datetime.now()

    data = "\t".join([
        "",
        "1",          # payment
        "1",          # simple payment
        amount_str,   # amount - empty string = open amount
        currency,
        date.strftime("%Y%m%d"),
        "",           # variable symbol
        "",           # constant symbol
        "",           # specific symbol
        "",           # SEPA format entries
        note,
        "1",          # to an account
        iban,
        swift,
        "0",          # not recurring
        "0",          # not inkaso
        beneficiary_name,
        "",           # address 1
        "",           # address 2
    ])

    checksum = binascii.crc32(data.encode()).to_bytes(4, "little")
    total = checksum + data.encode()

    compressed = lzma.compress(
        total,
        format=lzma.FORMAT_RAW,
        filters=[{
            "id": lzma.FILTER_LZMA1,
            "lc": 3,
            "lp": 0,
            "pb": 2,
            "dict_size": 128 * 1024,
        }],
    )

    compressed_with_length = b"\x00\x00" + len(total).to_bytes(2, "little") + compressed
    binary = "".join(bin(b)[2:].zfill(8) for b in compressed_with_length)

    length = len(binary)
    remainder = length % 5
    if remainder:
        binary += "0" * (5 - remainder)
        length += 5 - remainder

    subst = "0123456789ABCDEFGHIJKLMNOPQRSTUV"
    return "".join(subst[int(binary[5 * i : 5 * i + 5], 2)] for i in range(length // 5))


# Generate with empty amount (open donation)
pay_data = generate_pay_by_square(
    amount_str="1.00",
    iban="SK5883300000002701011094",
    swift="FIOZSKBAXXX",
    beneficiary_name="New Level Church",
    currency="EUR",
    note="Dar pre New Level Church",
)

qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_M,
    box_size=10,
    border=4,
)
qr.add_data(pay_data)
qr.make(fit=True)

img = qr.make_image(fill_color="black", back_color="white")
img.save("images/dar-qr.png")
print(f"QR code saved to images/dar-qr.png")
print(f"Data: {pay_data[:60]}...")
