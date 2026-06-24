@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "BUILD=%ROOT%build_ext"
set "ZIP=%ROOT%gas-tools.zip"

echo ============================================
echo  Empaquetando Google Apps Script Tools
echo ============================================

:: Limpiar build anterior
if exist "%BUILD%" rmdir /s /q "%BUILD%"
if exist "%ZIP%" del "%ZIP%"

:: Crear estructura de directorios
mkdir "%BUILD%\extension\js\services"
mkdir "%BUILD%\extension\js\components"
mkdir "%BUILD%\extension\html"
mkdir "%BUILD%\src\html"
mkdir "%BUILD%\src\css"
mkdir "%BUILD%\src\js\modules"
mkdir "%BUILD%\src\js\utils"
mkdir "%BUILD%\src\components"
mkdir "%BUILD%\src\vendor\codemirror"
mkdir "%BUILD%\src\vendor\diff"
mkdir "%BUILD%\src\vendor\diff2html"
mkdir "%BUILD%\themes"
mkdir "%BUILD%\resources\icons"

:: manifest.json
copy "%ROOT%manifest.json" "%BUILD%"

:: extension\
copy "%ROOT%extension\background.js"                  "%BUILD%\extension\"
copy "%ROOT%extension\js\gas-tools.js"                "%BUILD%\extension\js\"
copy "%ROOT%extension\js\gas-tools-main.js"           "%BUILD%\extension\js\"
copy "%ROOT%extension\js\main-functions.js"           "%BUILD%\extension\js\"
copy "%ROOT%extension\js\services\*.js"               "%BUILD%\extension\js\services\"
copy "%ROOT%extension\js\components\*.js"             "%BUILD%\extension\js\components\"
copy "%ROOT%extension\html\*.html"                    "%BUILD%\extension\html\"

:: src\ (popup)
copy "%ROOT%src\html\index.html"                      "%BUILD%\src\html\"
copy "%ROOT%src\css\app.css"                          "%BUILD%\src\css\"
copy "%ROOT%src\js\app.js"                            "%BUILD%\src\js\"
copy "%ROOT%src\js\modules\*.js"                      "%BUILD%\src\js\modules\"
copy "%ROOT%src\js\utils\*.js"                        "%BUILD%\src\js\utils\"
copy "%ROOT%src\components\*.js"                      "%BUILD%\src\components\"
copy "%ROOT%src\vendor\codemirror\codemirror.js"      "%BUILD%\src\vendor\codemirror\"
copy "%ROOT%src\vendor\diff\diff.min.js"              "%BUILD%\src\vendor\diff\"
copy "%ROOT%src\vendor\diff2html\diff2html-ui.min.js" "%BUILD%\src\vendor\diff2html\"
copy "%ROOT%src\vendor\diff2html\diff2html.min.css"   "%BUILD%\src\vendor\diff2html\"

:: themes\
copy "%ROOT%themes\*.json"                            "%BUILD%\themes\"

:: icons
copy "%ROOT%resources\icons\icon16.png"               "%BUILD%\resources\icons\"
copy "%ROOT%resources\icons\icon48.png"               "%BUILD%\resources\icons\"
copy "%ROOT%resources\icons\icon128.png"              "%BUILD%\resources\icons\"

:: Comprimir
echo.
echo Comprimiendo...
powershell -Command "Compress-Archive -Path '%BUILD%\*' -DestinationPath '%ZIP%' -Force"

:: Mostrar tamaño
for %%A in ("%ZIP%") do echo ZIP creado: %%~nxA (%%~zA KB)

:: Limpiar
rmdir /s /q "%BUILD%"

echo.
echo ============================================
echo  Listo! Archivo: gas-tools.zip
echo ============================================

endlocal
pause