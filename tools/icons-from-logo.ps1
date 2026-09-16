# Rebuilds icons/icon{16,48,128}.png from icons/Listra Logo.jfif.
#
#   powershell -ExecutionPolicy Bypass -File tools\icons-from-logo.ps1
#
# Uses System.Drawing from the .NET framework already present on Windows, so there is
# no image dependency to install. tools/make-icons.js is the cross-platform fallback
# that draws placeholder icons in code instead.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'icons\Listra Logo.jfif'

if (-not (Test-Path $source)) {
    Write-Error "Logo not found at $source"
    exit 1
}

$image = [System.Drawing.Image]::FromFile($source)
try {
    foreach ($size in 16, 48, 128) {
        $bitmap = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            # High-quality resampling matters most at 16px, where the toolbar icon is
            # otherwise a smear.
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($image, 0, 0, $size, $size)
        }
        finally {
            $graphics.Dispose()
        }

        $target = Join-Path $root "icons\icon$size.png"
        $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        Write-Host "wrote icons\icon$size.png"
    }
}
finally {
    $image.Dispose()
}
