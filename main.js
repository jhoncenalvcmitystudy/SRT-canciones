/* Removed ES module import; use global Tesseract.createWorker provided by the UMD script loaded in index.html */

// Add keys for cache
const CACHE_KEYS = {
    scannedText: 'app_scanned_text_html',
    imageData: 'app_image_dataurl',
    audioData: 'app_audio_dataurl',
    spectrogramImage: 'app_spectrogram_dataurl',
    srtData: 'app_srt_data_json', // NEW: Cache key for SRT table data
    audioFilename: 'app_audio_filename', // NEW: cache the uploaded audio filename (base)
    history: 'app_history_json' // persistent history (must not be cleared by reset)
};

// Utility to save small items to localStorage safely
function saveToCache(key, value) {
    try {
        if (value === null || value === undefined) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
        updateCacheStatus();
    } catch (e) {
        console.warn('Save to cache failed', e);
    }
}
function loadFromCache(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        console.warn('Load from cache failed', e);
        return null;
    }
}
function clearCache() {
    try {
        // Do not remove persistent history key
        Object.values(CACHE_KEYS).forEach(k => {
            if (k === CACHE_KEYS.history) return;
            localStorage.removeItem(k);
        });
        updateCacheStatus();
        // Also clear in-memory gallery/UI if present
        try {
            imageGalleryItems = [];
            const galleryEl = document.getElementById('image-gallery');
            if (galleryEl) galleryEl.innerHTML = '';
            const imgPreview = document.getElementById('image-preview');
            if (imgPreview) { imgPreview.src = '#'; imgPreview.style.display = 'none'; }
            currentOriginalImage = null;
        } catch (e) {
            // DOM might not be ready; ignore
        }
    } catch (e) {
        console.warn('Clear cache failed', e);
    }
}

// Update cache status text in descargar section
function updateCacheStatus() {
    const statusEl = document.getElementById('cache-status');
    if (!statusEl) return;
    const hasAny =
        !!loadFromCache(CACHE_KEYS.scannedText) ||
        !!loadFromCache(CACHE_KEYS.imageData) ||
        !!loadFromCache(CACHE_KEYS.audioData) ||
        !!loadFromCache(CACHE_KEYS.spectrogramImage) ||
        !!loadFromCache(CACHE_KEYS.srtData); // Include SRT data in cache status check
    statusEl.textContent = hasAny ? 'Elementos guardados en cache.' : 'Cache vacío.';
}

document.addEventListener('DOMContentLoaded', () => {
    const sidebarButtons = document.querySelectorAll('.sidebar-button');
    const contentSections = document.querySelectorAll('.content-section');
    const mainContent = document.querySelector('.main-content');

    // Elements for 'Subir imagen' section
    const imageInput = document.getElementById('image-input');
    const selectImageButton = document.getElementById('select-image-button');
    const dropArea = document.getElementById('drop-area');
    const imagePreview = document.getElementById('image-preview');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    const imageCanvas = document.getElementById('image-canvas');
    const ctx = imageCanvas.getContext('2d', { willReadFrequently: true });
    const imageGallery = document.getElementById('image-gallery');
    const preprocessingOptions = document.querySelectorAll('input[name="preprocessing"]');
    const ocrLanguageSelect = document.getElementById('ocr-language-select');
    const scanImageButton = document.getElementById('scan-image-button');
    const scanMessage = document.getElementById('scan-message');

    // Elements for 'Editar texto' section
    const scannedTextOutput = document.getElementById('scanned-text-output');
    const removeEmptyLinesButton = document.getElementById('remove-empty-lines-button');
    // new ready button to go to subir-audio
    const readyButton = document.getElementById('ready-button');

    // Add references for new audio-ready button and spectrogram elements
    const audioReadyButton = document.getElementById('audio-ready-button');
    const spectrogramBar = document.getElementById('spectrogram-bar');
    const spectrogramCanvas = document.getElementById('spectrogram-canvas');
    // New: Reference for the hover line
    const spectrogramHoverLine = document.getElementById('spectrogram-hover-line');
    let spectrogramZoom = 1;
    const minZoom = 0.5;
    const maxZoom = 10;
    const zoomFactor = 1.1;

    // New: Reference for SRT table body
    const srtTableBody = document.querySelector('#srt-table tbody');

    // New: Reference for SRT regions container
    const spectrogramRegionsContainer = document.getElementById('spectrogram-regions-container');

    // Define a fixed height for the spectrogram canvas to make it "flattened"
    // This value needs to be consistent wherever spectrogramCanvas.height is set or used.
    const SPECTROGRAM_DISPLAY_HEIGHT = 80; // pixels

    let currentOriginalImage = null; // Stores the actual Image DOM element after loading
    let tesseractWorker = null;
    let currentWorkerLanguage = '';

    // Function to render the correct content section
    const renderSection = (sectionId) => {
        contentSections.forEach(section => {
            section.classList.remove('active');
            section.classList.add('hidden');
        });
        const targetSection = document.getElementById(sectionId);
        if (targetSection) {
            targetSection.classList.add('active');
            targetSection.classList.remove('hidden');
        }
    };

    // Function to update active sidebar button
    const updateActiveButton = (activeButton) => {
        sidebarButtons.forEach(btn => btn.classList.remove('active'));
        activeButton.classList.add('active');
    };

    // Sidebar button click handler
    sidebarButtons.forEach(button => {
        button.addEventListener('click', () => {
            updateActiveButton(button);
            // Support the new "principal" section which maps to 'principal-section'
            const target = button.dataset.section === 'principal' ? 'principal-section' : (button.dataset.section + '-section');
            renderSection(target);
        });
    });

    // Hero quick-action buttons on the principal section
    document.querySelectorAll('.hero-actions .action-button').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetSection = btn.dataset.sectionTarget;
            const targetBtn = document.querySelector(`.sidebar-button[data-section="${targetSection}"]`);
            if (targetBtn) {
                updateActiveButton(targetBtn);
                renderSection(`${targetSection}-section`);
            }
        });
    });

    // Initialize content based on active button (or default to 'Subir imagen')
    const initialActiveButton = document.querySelector('.sidebar-button.active');
    if (initialActiveButton) {
        renderSection(initialActiveButton.dataset.section + '-section');
    } else if (sidebarButtons.length > 0) {
        // Fallback if no active button is set in HTML
        sidebarButtons[0].classList.add('active');
        renderSection(sidebarButtons[0].dataset.section + '-section');
    }

    // --- Subir imagen section functionality ---

    // Trigger file input click
    selectImageButton.addEventListener('click', () => {
        imageInput.click();
    });

    // Defensive: if selectImageButton missing for any reason, allow clicking its container
    const dropAreaElement = dropArea || document.getElementById('drop-area');
    if (dropAreaElement) {
        dropAreaElement.addEventListener('click', (e) => {
            // avoid triggering when clicking interactive children
            if (e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.closest('button'))) return;
            imageInput.click();
        });
    }

    // Handle image file selection (support multiple images)
    imageInput.setAttribute('multiple', '');
    imageInput.addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        handleImages(files);
    });

    // Drag and drop functionality
    dropArea.addEventListener('dragover', (event) => {
        event.preventDefault();
        dropArea.classList.add('drag-over');
    });

    dropArea.addEventListener('dragleave', () => {
        dropArea.classList.remove('drag-over');
    });

    dropArea.addEventListener('drop', (event) => {
        event.preventDefault();
        dropArea.classList.remove('drag-over');
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) handleImages(files);
    });

    // Paste image functionality
    document.addEventListener('paste', (event) => {
        const items = event.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                const file = items[i].getAsFile();
                if (file) {
                    handleImages([file]);
                    event.preventDefault(); // Prevent default paste behavior
                }
                break;
            }
        }
    });

    // Small gallery state: array of { file, dataUrl, imgEl }
    let imageGalleryItems = [];

    // Function to draw image on canvas
    const drawImageOnCanvas = (img) => {
        imageCanvas.width = img.naturalWidth;
        imageCanvas.height = img.naturalHeight;
        ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
        ctx.drawImage(img, 0, 0);
    };

    function clearGallery() {
        imageGalleryItems = [];
        if (imageGallery) imageGallery.innerHTML = '';
        currentOriginalImage = null;
        imagePreview.style.display = 'none';
    }

    // Populate thumbnail gallery
    function renderGallery() {
        if (!imageGallery) return;
        imageGallery.innerHTML = '';
        imageGalleryItems.forEach((it, idx) => {
            const img = document.createElement('img');
            img.className = 'thumb' + (idx === 0 ? ' selected' : '');
            img.src = it.dataUrl;
            img.alt = `Imagen ${idx + 1}`;
            img.tabIndex = 0;
            img.addEventListener('click', () => {
                // mark selection visual
                imageGallery.querySelectorAll('.thumb').forEach((t) => t.classList.remove('selected'));
                img.classList.add('selected');
                currentOriginalImage = it.imgEl;
                updateImagePreview();
            });
            img.addEventListener('keydown', (e) => { if (e.key === 'Enter') img.click(); });
            imageGallery.appendChild(img);
        });
        // auto-select first if exists
        if (imageGalleryItems.length > 0 && !currentOriginalImage) {
            currentOriginalImage = imageGalleryItems[0].imgEl;
            updateImagePreview();
        }
    }

    // Handle multiple image files
    function handleImages(files) {
        if (!files || files.length === 0) return;
        // append to existing gallery preserving order
        const readers = files.map(f => new Promise((res) => {
            const r = new FileReader();
            r.onload = (ev) => {
                const dataUrl = ev.target.result;
                const img = new Image();
                img.onload = () => res({ file: f, dataUrl, imgEl: img });
                img.src = dataUrl;
            };
            r.readAsDataURL(f);
        }));
        Promise.all(readers).then(results => {
            // push in given order
            results.forEach(it => imageGalleryItems.push(it));
            // Save last image dataurl to image cache (keep first's data too)
            if (imageGalleryItems[0]) saveToCache(CACHE_KEYS.imageData, imageGalleryItems[0].dataUrl);
            renderGallery();
        });
    }

    // Function to apply preprocessing effects on canvas
    const applyPreprocessingOnCanvas = (imgElement, preprocessingType) => {
        if (!imgElement) return null;

        drawImageOnCanvas(imgElement); // Always start from original image

        if (preprocessingType === 'grayscale-contrast') {
            const imageData = ctx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
            const data = imageData.data;
            const contrastFactor = 1.2; // Adjust for more/less contrast (1.0 is no change)
            const brightness = 0; // Adjust for brightness

            for (let i = 0; i < data.length; i += 4) {
                // Convert to grayscale
                const avg = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
                data[i] = avg; // R
                data[i + 1] = avg; // G
                data[i + 2] = avg; // B

                // Apply contrast and brightness
                data[i] = (avg - 128) * contrastFactor + 128 + brightness;
                data[i + 1] = (avg - 128) * contrastFactor + 128 + brightness;
                data[i + 2] = (avg - 128) * contrastFactor + 128 + brightness;

                // Clamp values
                data[i] = Math.min(255, Math.max(0, data[i]));
                data[i + 1] = Math.min(255, Math.max(0, data[i + 1]));
                data[i + 2] = Math.min(255, Math.max(0, data[i + 2]));
            }
            ctx.putImageData(imageData, 0, 0);
        } else if (preprocessingType === 'binarization') {
            const imageData = ctx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
            const data = imageData.data;
            // Simple fixed threshold, could be improved with Otsu's method
            const threshold = 128; 
            for (let i = 0; i < data.length; i += 4) {
                // Convert to grayscale using perceived luminance
                const avg = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
                const color = avg > threshold ? 255 : 0;
                data[i] = color; // R
                data[i + 1] = color; // G
                data[i + 2] = color; // B
            }
            ctx.putImageData(imageData, 0, 0);
        }
        // For 'none', the original image is already drawn on the canvas.
    };

    // Update image preview based on selected preprocessing option
    const updateImagePreview = () => {
        if (!currentOriginalImage) {
            imagePreview.style.display = 'none';
            imagePreviewContainer.style.display = 'flex'; // Keep container visible, maybe with a message
            return;
        }

        const selectedPreprocessing = document.querySelector('input[name="preprocessing"]:checked').value;
        applyPreprocessingOnCanvas(currentOriginalImage, selectedPreprocessing); // Apply to the hidden canvas
        imagePreview.src = imageCanvas.toDataURL(); // Update image preview from canvas
        imagePreview.style.display = 'block';
        imagePreviewContainer.style.display = 'flex';
        scanImageButton.disabled = false;
    };

    // Function to handle displaying the image
    /* ...existing code removed (single-handle) ... */
    // (multiple-file flow handled by handleImages above)

    // Event listener for preprocessing radio buttons
    preprocessingOptions.forEach(radio => {
        radio.addEventListener('change', updateImagePreview);
    });

    // Tesseract worker initialization and language handling
    async function getInitializedTesseractWorker(lang) {
        if (!tesseractWorker || currentWorkerLanguage !== lang) {
            if (tesseractWorker) {
                await tesseractWorker.terminate(); // Terminate existing worker if language changed
            }
            scanMessage.classList.remove('hidden');
            scanMessage.textContent = 'Inicializando OCR...';
            
            tesseractWorker = await Tesseract.createWorker({
                logger: m => {
                    if (m.status === 'recognizing text') {
                        const progress = Math.round(m.progress * 100);
                        scanMessage.textContent = `Escaneando imagen: ${progress}%`;
                    } else if (m.status === 'loading tesseract core' || m.status === 'loading language traineddata') {
                        scanMessage.textContent = `Cargando OCR: ${Math.round(m.progress * 100)}% (${m.status.replace('loading ', '').replace(' traineddata', '')})...`;
                    } else {
                        scanMessage.textContent = `Estado OCR: ${m.status}`;
                    }
                }
            });
            await tesseractWorker.loadLanguage(lang);
            await tesseractWorker.initialize(lang);
            currentWorkerLanguage = lang;
            scanMessage.textContent = 'OCR listo.';
        }
        return tesseractWorker;
    }

    // OCR execution
    scanImageButton.addEventListener('click', async () => {
        if ((!currentOriginalImage) && imageGalleryItems.length === 0) {
            alert('Por favor, primero sube o pega al menos una imagen para escanear.');
            return;
        }

        scanImageButton.disabled = true;
        scanMessage.classList.remove('hidden');
        scanMessage.textContent = 'Preparando escaneo...';

        try {
            const selectedLang = ocrLanguageSelect.value;
            const worker = await getInitializedTesseractWorker(selectedLang);

            // If multiple images in gallery, process them in order and concatenate text results
            const selectedPreprocessing = document.querySelector('input[name="preprocessing"]:checked').value;
            let finalTextParts = [];
            const itemsToProcess = imageGalleryItems.length > 0 ? imageGalleryItems : (currentOriginalImage ? [{ imgEl: currentOriginalImage }] : []);
            for (let i = 0; i < itemsToProcess.length; i++) {
                const item = itemsToProcess[i];
                // ensure canvas contains this image with preprocessing
                applyPreprocessingOnCanvas(item.imgEl, selectedPreprocessing);
                const { data: { text } } = await worker.recognize(imageCanvas);
                finalTextParts.push(text || '');
            }
            const combinedText = finalTextParts.join('\n\n'); // preserve separation and order
            // Populate contenteditable div, converting newlines to <br> for visual formatting
            scannedTextOutput.innerHTML = combinedText.replace(/\n/g, '<br>');
            // save scanned text to cache (HTML)
            saveToCache(CACHE_KEYS.scannedText, scannedTextOutput.innerHTML);

            // Switch to 'Editar texto' section
            const editarTextoButton = document.querySelector('.sidebar-button[data-section="editar-texto"]');
            if (editarTextoButton) {
                updateActiveButton(editarTextoButton);
                renderSection('editar-texto-section');
            }

        } catch (error) {
            console.error('Error durante el escaneo OCR:', error);
            alert('Hubo un error al escanear la imagen. Por favor, inténtalo de nuevo.');
            scannedTextOutput.innerHTML = '<p style="color:red;">Error al escanear la imagen. Consulta la consola para más detalles.</p>';
        } finally {
            scanImageButton.disabled = false;
            scanMessage.classList.add('hidden');
            scanMessage.textContent = ''; // Clear message
        }
    });

    // Handler to remove empty lines from contenteditable div
    removeEmptyLinesButton.addEventListener('click', () => {
        // Get plain text preserving line breaks
        let html = scannedTextOutput.innerHTML || '';
        // Convert <br> and block tags to newlines for consistent processing
        const temp = document.createElement('div');
        temp.innerHTML = html;
        // Replace BRs with newline markers
        temp.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        // Convert block elements to newlines separation
        const textContent = Array.from(temp.childNodes).map(node => {
            return node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.innerText;
        }).join('\n');

        // Split lines, trim, and filter out empty lines
        const lines = textContent.split(/\r?\n/).map(l => l.replace(/\u00A0/g, ' ').trim());
        const nonEmpty = lines.filter(l => l.length > 0);

        // Set back as HTML with <br> between lines
        scannedTextOutput.innerHTML = nonEmpty.map(line => {
            // Escape HTML to avoid injection
            const div = document.createElement('div');
            div.textContent = line;
            return div.innerHTML;
        }).join('<br>');
        scannedTextOutput.focus();
        // Save the updated text to cache
        saveToCache(CACHE_KEYS.scannedText, scannedTextOutput.innerHTML);
    });

    // Add handler for "Listo" button to switch to subir-audio section and set sidebar active
    readyButton.addEventListener('click', () => {
        // Save the current content of the scanned text output before navigating
        saveToCache(CACHE_KEYS.scannedText, scannedTextOutput.innerHTML);

        const subirAudioBtn = document.querySelector('.sidebar-button[data-section="subir-audio"]');
        if (subirAudioBtn) {
            updateActiveButton(subirAudioBtn);
        }
        renderSection('subir-audio-section');
    });

    // "Listo" button under audio preview navigates to Modificar SRT section
    audioReadyButton.addEventListener('click', () => {
        const modificarBtn = document.querySelector('.sidebar-button[data-section="modificar-srt"]');
        if (modificarBtn) updateActiveButton(modificarBtn);
        renderSection('modificar-srt-section');
        // ensure spectrogram bar is visible / focusable
        if (spectrogramBar) spectrogramBar.focus();
        // NEW: Always (re)generate SRT table from current scanned text when explicitly navigating here
        // This implicitly saves it to cache afterwards.
        generateSrtTableFromScannedText();
    });

    // Add handler for SRT "Listo" button (navigate to Descargar and save SRT cache)
    const srtReadyButton = document.getElementById('srt-ready-button');
    if (srtReadyButton) {
        srtReadyButton.addEventListener('click', () => {
            saveSrtTableToCache(); // ensure latest saved
            const descargarBtn = document.querySelector('.sidebar-button[data-section="descargar"]');
            if (descargarBtn) updateActiveButton(descargarBtn);
            renderSection('descargar-section');
        });
    }

    // Elements for 'Subir audio' functionality (new)
    const audioInput = document.getElementById('audio-input');
    const selectAudioButton = document.getElementById('select-audio-button');
    const audioPreview = document.getElementById('audio-preview');
    const audioPreviewContainer = document.getElementById('audio-preview-container');
    const audioFilename = document.getElementById('audio-filename');

    // Allow selecting audio via button and load chosen file into the audio preview + cache + generate spectrogram
    if (selectAudioButton && audioInput) {
        selectAudioButton.addEventListener('click', () => audioInput.click());
    }
    let audioFileNameBase = 'subtitles'; // NEW: base filename to use for SRT download
    if (audioInput) {
        audioInput.addEventListener('change', async (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (e) => {
                const dataUrl = e.target.result;
                audioPreview.src = dataUrl;
                audioPreviewContainer.style.display = 'block';
                audioFilename.textContent = file.name;
                audioReadyButton.style.display = 'inline-block';

                // Save base filename (without extension) to use when downloading SRT
                audioFileNameBase = file.name.replace(/\.[^/.]+$/, '') || 'subtitles';
                saveToCache(CACHE_KEYS.audioData, dataUrl);
                saveToCache(CACHE_KEYS.audioFilename, audioFileNameBase); // persist filename

                // attempt to (re)generate spectrogram once the audio is ready
                try { await generateSpectrogram(dataUrl); } catch (err) { console.error('Spectrogram gen error', err); }
            };
            reader.readAsDataURL(file);
        });
    }

    // Create or reference a progress line inside spectrogram bar
    let progressLine = document.createElement('div');
    progressLine.className = 'spectrogram-progress-line';
    // ensure it's positioned using left to avoid transform rounding and sync issues
    progressLine.style.left = '0px';
    progressLine.style.transform = 'none';
    spectrogramBar.appendChild(progressLine);

    // Use pointer events on the spectrogram bar for consistent dragging and clicks
    let isDraggingProgress = false;
    spectrogramBar.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        isDraggingProgress = true;
        document.body.style.userSelect = 'none';
        spectrogramBar.setPointerCapture(ev.pointerId);
    });
    spectrogramBar.addEventListener('pointermove', (ev) => {
        if (!isDraggingProgress) return;
        const barRect = spectrogramBar.getBoundingClientRect();
        const contentX = (ev.clientX - barRect.left) + spectrogramBar.scrollLeft;
        // use full logical width * zoom so dragging covers the whole generated spectrogram
        const renderedWidth = Math.max(1, Math.round((spectrogramCanvas.width || 0) * (spectrogramZoom || 1)));
        const ratio = Math.max(0, Math.min(1, contentX / renderedWidth));
        if (audioPreview && audioPreview.duration && isFinite(audioPreview.duration)) {
            audioPreview.currentTime = ratio * audioPreview.duration;
        }
        setProgressPositionFromRatio(ratio);
    });
    spectrogramBar.addEventListener('pointerup', (ev) => {
        if (!isDraggingProgress) return;
        isDraggingProgress = false;
        document.body.style.userSelect = '';
        try { spectrogramBar.releasePointerCapture(ev.pointerId); } catch(e){}
    });

    // Also support quick Ctrl+click to jump
    spectrogramBar.addEventListener('click', (ev) => {
        if (ev.button !== 0) return;
        if (!audioPreview || !audioPreview.duration || !isFinite(audioPreview.duration)) return;
        const barRect = spectrogramBar.getBoundingClientRect();
        const contentX = (ev.clientX - barRect.left) + spectrogramBar.scrollLeft;
        // use full logical width * zoom so clicks map to the full spectrogram length
        const renderedWidth = Math.max(1, Math.round((spectrogramCanvas.width || 0) * (spectrogramZoom || 1)));
        const ratio = Math.max(0, Math.min(1, contentX / renderedWidth));
        audioPreview.currentTime = ratio * audioPreview.duration;
        setProgressPositionFromRatio(ratio);
        updateProgressLine();
    });

    // Add Ctrl+wheel zoom handling scoped to the spectrogramBar to avoid global page zoom
    if (spectrogramBar) {
        spectrogramBar.addEventListener('wheel', (ev) => {
            // If Ctrl pressed -> zoom (and prevent browser/page zoom). Otherwise convert wheel gesture into horizontal scroll for the spectrogram.
            // Prefer horizontal delta (touchpad two-finger) when available, fallback to vertical delta for mouse wheel.
            if (ev.ctrlKey) {
                ev.preventDefault(); // stop browser/page zoom

                // Capture previous rendered width so we can preserve view center/selection after zoom
                const prevRenderedWidth = Math.max(1, Math.round((spectrogramCanvas.width || 0) * (spectrogramZoom || 1)));

                // compute center ratio relative to full content so we can restore same focal point after zoom
                const focalX = (spectrogramBar.scrollLeft + (spectrogramBar.clientWidth / 2));
                const focalRatio = prevRenderedWidth > 0 ? (focalX / prevRenderedWidth) : 0;

                // Use the vertical delta sign for zoom direction (consistent with prior behavior)
                const delta = Math.sign(ev.deltaY || ev.wheelDelta || -ev.detail);
                if (delta > 0) spectrogramZoom = Math.max(minZoom, spectrogramZoom / zoomFactor);
                else if (delta < 0) spectrogramZoom = Math.min(maxZoom, spectrogramZoom * zoomFactor);

                if (spectrogramCanvas && spectrogramCanvas.width) spectrogramCanvas.style.width = `${Math.max(1, Math.round(spectrogramCanvas.width * spectrogramZoom))}px`;

                // Re-draw / reposition regions and progress after zoom change
                drawSrtRegions();
                // Recompute new rendered width and restore scroll so the previous focal point remains centered
                const newRenderedWidth = Math.max(1, Math.round((spectrogramCanvas.width || 0) * (spectrogramZoom || 1)));
                const desiredScrollLeft = Math.max(0, Math.round(focalRatio * newRenderedWidth - (spectrogramBar.clientWidth / 2)));
                spectrogramBar.scrollLeft = Math.min(desiredScrollLeft, newRenderedWidth - spectrogramBar.clientWidth);

                setProgressPositionFromRatio(currentProgressRatio || 0);
            } else {
                // Scroll horizontally inside the spectrogram bar using touchpad or mouse wheel.
                ev.preventDefault();
                const speed = 1.5; // tweak scroll sensitivity

                // Prefer deltaX from touchpad gestures; if zero use deltaY from vertical wheel.
                // On some devices deltaMode may be different but using deltaX/deltaY is sufficient for most touchpads.
                let horizontalDelta = ev.deltaX;
                if (!horizontalDelta || Math.abs(horizontalDelta) < 0.0001) {
                    // fallback to vertical wheel movement
                    horizontalDelta = ev.deltaY;
                }

                // If Shift is held, invert behavior to match native expectations
                const invert = ev.shiftKey ? -1 : 1;

                spectrogramBar.scrollLeft += horizontalDelta * speed * invert;
            }
        }, { passive: false });
    }

    let rafId = null;
    let currentProgressRatio = 0; // store the last known ratio (0..1) for stable zoom & positioning

    // High-frequency watcher to clamp playback precisely to selected region end
    let regionWatcherRaf = null;
    function startRegionWatcher() {
        stopRegionWatcher();
        const rows = srtTableBody ? srtTableBody.querySelectorAll('tr') : [];
        if (selectedSrtIndex === null || !rows[selectedSrtIndex] || !audioPreview || suppressRegionEnforcement) return;
        
        const check = () => {
            if (!audioPreview || audioPreview.paused || selectedSrtIndex === null || suppressRegionEnforcement) {
                regionWatcherRaf = null;
                return;
            }

            // Re-fetch the row and times on every frame to get live updates during resize.
            const currentRows = srtTableBody ? srtTableBody.querySelectorAll('tr') : [];
            const row = currentRows[selectedSrtIndex];
            if (!row) { // Safety check in case the table changes
                regionWatcherRaf = null;
                return;
            }

            const endMs = parseFloat(row.children[2].dataset.time) || 0;
            const startMs = parseFloat(row.children[1].dataset.time) || 0;

            const currentMs = (audioPreview.currentTime || 0) * 1000;
            // Use a tiny epsilon to account for scheduling; clamp as soon as we reach or pass end
            if (currentMs >= endMs) {
                audioPreview.pause();
                // When clamping, use the dynamically fetched endMs to ensure it stops at the latest edited position.
                audioPreview.currentTime = endMs / 1000;
                regionWatcherRaf = null; // Stop the loop
                return;
            } else if (currentMs < startMs) {
                 // If playback somehow moved before start, clamp back to start while selected
                 audioPreview.currentTime = startMs / 1000;
            }
            regionWatcherRaf = requestAnimationFrame(check);
        };
        regionWatcherRaf = requestAnimationFrame(check);
    }
    function stopRegionWatcher() {
        if (regionWatcherRaf) cancelAnimationFrame(regionWatcherRaf);
        regionWatcherRaf = null;
    }

    // Central helper: compute rendered canvas width and set progress line based on a ratio (0..1)
    function setProgressPositionFromRatio(ratio) {
        if (!spectrogramCanvas || !spectrogramBar || !progressLine) return;
        currentProgressRatio = Math.max(0, Math.min(1, ratio));

        // Use the full logical canvas width multiplied by zoom. This is the total scrollable width.
        const renderedWidth = Math.max(1, Math.round((spectrogramCanvas.width || 0) * (spectrogramZoom || 1)));

        // Calculate the absolute horizontal position (x) of the progress line within the entire spectrogram content.
        const x = Math.round(currentProgressRatio * renderedWidth);

        // The progress line is a child of the spectrogramBar (the scroll container).
        // By setting its `left` style, we position it relative to the start of the scrollable content.
        // This ensures it moves correctly across the full width of the canvas, independent of the current scrollLeft value.
        progressLine.style.left = `${x}px`;
        progressLine.style.display = (audioPreview && audioPreview.src && audioPreview.duration && isFinite(audioPreview.duration)) ? 'block' : 'none';
    }

    // Real-time updater for the progress line, driven by RAF; keeps line synchronized with audio time and view
    function updateProgressLine() {
        if (!audioPreview || !spectrogramCanvas) return;
        if (rafId) cancelAnimationFrame(rafId);
        const update = () => {
            const duration = (audioPreview.duration && isFinite(audioPreview.duration)) ? audioPreview.duration : 0;
            const ratio = duration > 0 ? Math.max(0, Math.min(1, (audioPreview.currentTime || 0) / duration)) : currentProgressRatio || 0;
            setProgressPositionFromRatio(ratio);
            // keep RAF running only while audio is playing
            if (!audioPreview.paused && !audioPreview.ended) rafId = requestAnimationFrame(update);
            else rafId = null;
        };
        // run one immediate update and start RAF loop if playing
        update();
    }

    // NEW: reset progress line helper (prevents ReferenceError from reset button)
    function resetProgressLine() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        currentProgressRatio = 0;
        if (progressLine) {
            progressLine.style.left = '0px';
            progressLine.style.display = 'none';
        }
    }

    // NEW: state for selection and resizing
    let selectedSrtIndex = null;
    let suppressRegionEnforcement = false; // when true, timeupdate won't clamp playback to selected region
    let isResizing = false;
    let resizingEdge = null; // 'left' or 'right'
    let resizeStartX = 0;
    let resizeStartY = 0;
    let resizeStartContentX = 0; // content-space X (includes scroll)
    let resizeRegionEl = null;
    let resizeOriginal = { left: 0, width: 0, startTime: 0, endTime: 0 };

    // Helper: select region by index (sync table row + region visuals)
    function selectRegionByIndex(index, playOnSelect = true) {
        selectedSrtIndex = (index === null) ? null : Number(index);
        // highlight table row
        const rows = srtTableBody.querySelectorAll('tr');
        rows.forEach((row, i) => {
            row.classList.toggle('selected-row', (i === selectedSrtIndex));
            // prevent editing other rows' content when one is selected
            const contentCell = row.querySelector('.editable-content');
            if (contentCell) {
                contentCell.contentEditable = (selectedSrtIndex === null) || (i === selectedSrtIndex);
            }
        });
        // highlight region and disable others
        const regions = spectrogramRegionsContainer.querySelectorAll('.srt-region');
        regions.forEach((r, i) => {
            r.classList.toggle('selected', (i === selectedSrtIndex));
            if (selectedSrtIndex === null) {
                r.classList.remove('disabled');
            } else {
                if (i === selectedSrtIndex) r.classList.remove('disabled');
                else r.classList.add('disabled');
            }
        });

        // If selected, make audio loop that interval and seek to its start and play
        if (selectedSrtIndex !== null && playOnSelect) {
            const row = srtTableBody.querySelectorAll('tr')[selectedSrtIndex];
            if (row) {
                const startMs = parseFloat(row.children[1].dataset.time) || 0;
                const endMs = parseFloat(row.children[2].dataset.time) || 0;
                if (audioPreview && isFinite(audioPreview.duration) && endMs > startMs) {
                    audioPreview.currentTime = startMs / 1000;
                    audioPreview.play().catch(()=>{});
                    // start precise watcher to ensure exact stop at endMs
                    startRegionWatcher();
                }
            }
        } else {
            // nothing selected -> normal playback
            stopRegionWatcher();
        }
    }

    // Update time cells & cache after resizing or edits
    function updateTimeCellsAndCache(rowIndex, newStartMs, newEndMs) {
        const rows = srtTableBody.querySelectorAll('tr');
        const row = rows[rowIndex];
        if (!row) return;
        row.children[1].dataset.time = newStartMs;
        row.children[1].textContent = formatTime(newStartMs);
        row.children[2].dataset.time = newEndMs;
        row.children[2].textContent = formatTime(newEndMs);
        saveSrtTableToCache();
        drawSrtRegions();
    }

    // NEW: Function to pick a distinct color for each region index
    function pickRegionColor(index) {
        const palette = [
            [74,144,226],  // blue
            [46,204,113],  // green
            [241,196,15],  // yellow
            [231,76,60],   // red
            [155,89,182],  // purple
            [26,188,156],  // teal
            [52,152,219],  // lighter blue
            [230,126,34],  // orange
            [127,140,141], // gray
            [52,73,94]     // dark slate
        ];
        const c = palette[index % palette.length];
        return `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.45)`; // semi-opaque fill
    }

    // NEW: Function to draw subtitle regions on the spectrogram
    function drawSrtRegions() {
        if (!spectrogramRegionsContainer || !srtTableBody || !audioPreview || !audioPreview.duration || !isFinite(audioPreview.duration)) {
            spectrogramRegionsContainer && (spectrogramRegionsContainer.innerHTML = '');
            return;
        }

        spectrogramRegionsContainer.innerHTML = ''; // Clear previous regions

        const audioDuration = audioPreview.duration;
        const totalRenderedWidth = spectrogramCanvas.width * spectrogramZoom;

        const rows = srtTableBody.querySelectorAll('tr');

        rows.forEach((row, rowIndex) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 4) return; // Skip header or invalid rows

            const startTimeMs = parseFloat(cells[1].dataset.time);
            const endTimeMs = parseFloat(cells[2].dataset.time);

            if (isNaN(startTimeMs) || isNaN(endTimeMs)) return;

            const startRatio = startTimeMs / (audioDuration * 1000);
            const endRatio = endTimeMs / (audioDuration * 1000);

            const left = startRatio * totalRenderedWidth;
            const width = (endRatio - startRatio) * totalRenderedWidth;
            
            if (width > 0) {
                const regionDiv = document.createElement('div');
                regionDiv.className = 'srt-region';
                regionDiv.style.left = `${left}px`;
                regionDiv.style.width = `${width}px`;
                regionDiv.dataset.index = rowIndex;
                regionDiv.title = `Intervalo ${rowIndex+1}`;

                // assign distinct semi-opaque background color per region
                regionDiv.style.backgroundColor = pickRegionColor(rowIndex);
                // make borders a slightly darker version of the same color
                // create a border color by reducing alpha and darkening slightly
                regionDiv.style.borderLeftColor = regionDiv.style.borderRightColor = regionDiv.style.backgroundColor.replace('0.45', '0.85');

                // pointer cursor to indicate edges are adjustable
                regionDiv.style.cursor = 'move';

                spectrogramRegionsContainer.appendChild(regionDiv);
            }
        });

        // restore selected visual if any
        if (selectedSrtIndex !== null) {
            const sel = spectrogramRegionsContainer.querySelector(`.srt-region[data-index="${selectedSrtIndex}"]`);
            if (sel) sel.classList.add('selected');
        }
    }

    /* Pointer interaction for resizing edges (delegated) — clicking edges starts resizing, but left-clicking a different region will no longer change selection.
       Selection/focus is controlled by keyboard navigation (q/w/arrows) or explicit resizing actions. */
    spectrogramRegionsContainer.addEventListener('pointerdown', (ev) => {
        const target = ev.target.closest('.srt-region');
        if (!target) return;
        ev.preventDefault();

        const targetIndex = Number(target.dataset.index);
        const rect = target.getBoundingClientRect();
        const localX = ev.clientX - rect.left;
        const edgeThreshold = 12; // tolerance in pixels for grabbing an edge

        // Determine if this pointerdown is intended as an edge-resize (near left or right edge)
        const nearLeft = localX <= edgeThreshold;
        const nearRight = localX >= rect.width - edgeThreshold;
        const nearEdge = nearLeft || nearRight;

        // Resizing: allow when clicking near edges (left or right) with left or right button
        if ((ev.button === 2) || (ev.button === 0 && nearEdge)) {
            // Choose edge based on proximity (if not explicitly near one, pick nearest)
            if (nearLeft) resizingEdge = 'left';
            else if (nearRight) resizingEdge = 'right';
            else {
                const distLeft = Math.abs(localX - 0);
                const distRight = Math.abs(localX - rect.width);
                resizingEdge = (distLeft <= distRight) ? 'left' : 'right';
            }

            isResizing = true;
            resizeRegionEl = target;
            // add visual resizing class
            resizeRegionEl.classList.add('resizing');
            resizeStartX = ev.clientX;
            resizeStartY = ev.clientY;
            // Compute start X in content coordinates (accounts for scroll)
            const barRect = spectrogramBar.getBoundingClientRect();
            resizeStartContentX = (ev.clientX - barRect.left) + spectrogramBar.scrollLeft;

            resizeOriginal.left = parseFloat(target.style.left) || 0;
            resizeOriginal.width = parseFloat(target.style.width) || 0;
            const idx = Number(target.dataset.index);
            const row = srtTableBody.querySelectorAll('tr')[idx];
            resizeOriginal.startTime = parseFloat(row.children[1].dataset.time) || 0;
            resizeOriginal.endTime = parseFloat(row.children[2].dataset.time) || 0;

            // Select the region visually for clarity but do not force playback changes here
            selectRegionByIndex(targetIndex, false);

            // If audio is paused, start playing from the region start so the watcher enforces the dynamic boundary during resize.
            if (audioPreview && audioPreview.paused) {
                audioPreview.currentTime = resizeOriginal.startTime / 1000;
                audioPreview.play().catch(()=>{});
            }

            // capture pointer so we continue receiving events even if cursor leaves the element
            try {
                if (spectrogramBar && typeof spectrogramBar.setPointerCapture === 'function') spectrogramBar.setPointerCapture(ev.pointerId);
                else if (typeof target.setPointerCapture === 'function') target.setPointerCapture(ev.pointerId);
            } catch(e){}
            return;
        }

        // Left-click away from edges: do not change selection when clicking a different region.
        // If the clicked region is already selected, keep behavior (so clicking inside the same selected region has no unexpected side-effects).
        if (ev.button === 0 && !nearEdge) {
            // If the clicked region is already the selected one, ensure enforcement is active and watcher runs.
            const currentlySelected = selectedSrtIndex !== null && Number(target.dataset.index) === selectedSrtIndex;
            if (currentlySelected) {
                suppressRegionEnforcement = false;
                startRegionWatcher();
            }
            // Otherwise, ignore the click to avoid changing the visible/selected region.
            return;
        }
    });

    // Hover/edge indicator: show handles and change cursor when pointer is near the left/right edge of regions.
    spectrogramRegionsContainer.addEventListener('pointermove', (ev) => {
        const target = ev.target.closest('.srt-region');
        // Clear any previous edge classes on all regions to avoid stale state
        spectrogramRegionsContainer.querySelectorAll('.srt-region').forEach(r => {
            r.classList.remove('can-resize', 'edge-left-hover', 'edge-right-hover');
        });
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const localX = ev.clientX - rect.left;
        const edgeThreshold = 12;
        const nearLeft = localX <= edgeThreshold;
        const nearRight = localX >= rect.width - edgeThreshold;

        // Indicate edges are movable when close enough; show handles for affordance
        if (nearLeft || nearRight) {
            target.classList.add('can-resize');
            if (nearLeft) target.classList.add('edge-left-hover');
            if (nearRight) target.classList.add('edge-right-hover');
        } else {
            // When hovering region body, indicate it can still be moved/selected (visually)
            target.classList.add('can-resize');
        }
    });

    // When pointer leaves the regions container, clear hover states
    spectrogramRegionsContainer.addEventListener('pointerleave', () => {
        spectrogramRegionsContainer.querySelectorAll('.srt-region').forEach(r => r.classList.remove('can-resize', 'edge-left-hover', 'edge-right-hover'));
    });

    // Prevent native context menu on spectrogram bar and its regions to allow right-click drag without browser menu
    if (spectrogramBar) {
        spectrogramBar.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    if (spectrogramRegionsContainer) {
        spectrogramRegionsContainer.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // Document-level pointermove/pointerup to ensure dragging continues when leaving the container
    document.addEventListener('pointermove', (ev) => {
        if (!isResizing || !resizeRegionEl) return;
        // reuse the same logic as the container pointermove handler by forwarding the event
        // Compute movement in content-space (includes scroll) to avoid scroll-induced jumps and ensure correct direction
        const barRect = spectrogramBar.getBoundingClientRect();
        const currentContentX = (ev.clientX - barRect.left) + spectrogramBar.scrollLeft;
        const deltaContentX = currentContentX - resizeStartContentX;
        const deltaY = ev.clientY - resizeStartY;
        const combinedDelta = deltaContentX - deltaY;

        const totalRenderedWidth = spectrogramCanvas.width * spectrogramZoom;
        const audioDurationMs = audioPreview.duration * 1000;

        let newLeft = resizeOriginal.left;
        let newWidth = resizeOriginal.width;

        if (resizingEdge === 'left') {
            const prevRight = (resizeRegionEl.previousElementSibling ? parseFloat(resizeRegionEl.previousElementSibling.style.left) + parseFloat(resizeRegionEl.previousElementSibling.style.width) : 0);
            const minLeft = prevRight + 2;
            const maxLeft = resizeOriginal.left + resizeOriginal.width - 2;
            newLeft = resizeOriginal.left + combinedDelta;
            newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
            newWidth = Math.max(2, resizeOriginal.left + resizeOriginal.width - newLeft);
        } else if (resizingEdge === 'right') {
            const nextLeft = (resizeRegionEl.nextElementSibling ? parseFloat(resizeRegionEl.nextElementSibling.style.left) : totalRenderedWidth);
            const maxAllowedWidth = Math.max(2, (nextLeft - 2) - resizeOriginal.left);
            newWidth = Math.max(2, Math.min(resizeOriginal.width + combinedDelta, maxAllowedWidth));
        }

        // Apply visual immediately
        resizeRegionEl.style.left = `${newLeft}px`;
        resizeRegionEl.style.width = `${newWidth}px`;

        // Compute new times and update table cells live
        const idx2 = Number(resizeRegionEl.dataset.index);
        const newStartRatio = newLeft / totalRenderedWidth;
        const newEndRatio = (newLeft + newWidth) / totalRenderedWidth;
        const newStartMs = Math.max(0, Math.min(audioDurationMs, newStartRatio * audioDurationMs));
        const newEndMs = Math.max(0, Math.min(audioDurationMs, newEndRatio * audioDurationMs));

        updateTimeCellsAndCache(idx2, newStartMs, newEndMs);

        // Immediate clamp: if playback is beyond the newly computed end, pause and seek back to the new end
        if (audioPreview && !isNaN(audioPreview.currentTime)) {
            const nowMs = (audioPreview.currentTime || 0) * 1000;
            if (nowMs >= newEndMs) {
                audioPreview.pause();
                audioPreview.currentTime = newEndMs / 1000;
            }
        }
    });

    document.addEventListener('pointerup', (ev) => {
        if (!isResizing) return;
        try {
            // Release capture from spectrogramBar if we set it there
            if (spectrogramBar && typeof spectrogramBar.releasePointerCapture === 'function') spectrogramBar.releasePointerCapture(ev.pointerId);
        } catch(e){}
        // remove resizing visual state if present
        if (resizeRegionEl && resizeRegionEl.classList) resizeRegionEl.classList.remove('resizing');
        isResizing = false;
        resizingEdge = null;
        resizeRegionEl = null;
        // Ensure the watcher is active after finishing a resize so playback remains clamped if still playing
        if (selectedSrtIndex !== null && audioPreview && !audioPreview.paused) startRegionWatcher();
    });

    // Ensure audio loops selected interval also on 'ended' fallback
    // If audio naturally ends, do not auto-loop; selection handling above (timeupdate) will manage region stop.
    audioPreview.addEventListener('ended', () => {
        // No automatic looping on 'ended'—the timeupdate handler handles region boundaries.
        // Keep the playback paused at the end.
    });

    // Redistribute existing SRT regions evenly within the window [10s, duration-5s] (fallbacks if too short)
    function redistributeSrtRegionsToAudioWindow() {
        if (!srtTableBody || !audioPreview || !audioPreview.duration || !isFinite(audioPreview.duration)) return;
        const rows = Array.from(srtTableBody.querySelectorAll('tr'));
        if (rows.length === 0) return;
        const durationMs = audioPreview.duration * 1000;
        // Desired window
        const windowStart = 10000; // 10s
        const windowEnd = Math.max(0, durationMs - 5000); // duration - 5s
        let startMs = windowStart;
        let endMs = windowEnd;
        // If the desired window is invalid or too small, fall back to full duration
        if (endMs <= startMs + 1) {
            startMs = 0;
            endMs = Math.max(durationMs, 1);
        }
        const totalWindow = Math.max(1, endMs - startMs);
        const perRegion = totalWindow / rows.length;

        rows.forEach((tr, i) => {
            const s = Math.round(startMs + i * perRegion);
            // Last region should end at window end to avoid rounding gaps
            const e = (i === rows.length - 1) ? Math.round(endMs) : Math.round(startMs + (i + 1) * perRegion);
            tr.children[1].dataset.time = s;
            tr.children[1].textContent = formatTime(s);
            tr.children[2].dataset.time = e;
            tr.children[2].textContent = formatTime(e);
        });
        saveSrtTableToCache();
        drawSrtRegions();
    }

    // When audio metadata is loaded, redistribute regions into the target window
    audioPreview.addEventListener('loadedmetadata', () => {
        // If there are already rows, redistribute them into the [10s, duration-5s] window
        if (srtTableBody && srtTableBody.querySelectorAll('tr').length > 0) {
            redistributeSrtRegionsToAudioWindow();
        }
        // Ensure spectrogram draws/updates progress
        updateProgressLine();
    });

    // Spectrogram generator function
    async function fftRealMagSquared(inputFrame, windowData) {
        const N = inputFrame.length;
        const re = new Float32Array(N);
        const im = new Float32Array(N);

        // Copy input frame and apply window
        for (let i = 0; i < N; i++) {
            re[i] = inputFrame[i] * windowData[i];
            im[i] = 0;
        }

        // Bit reversal permutation
        let j = 0;
        for (let i = 1; i < N - 1; i++) {
            let bit = N >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let tempRe = re[i]; re[i] = re[j]; re[j] = tempRe;
                let tempIm = im[i]; im[i] = im[j]; im[j] = tempIm;
            }
        }

        // Cooley-Tukey FFT stages
        for (let len = 2; len <= N; len <<= 1) {
            const angle = -2 * Math.PI / len;
            const wlenRe = Math.cos(angle);
            const wlenIm = Math.sin(angle);
            for (let i = 0; i < N; i += len) {
                let ur = 1, ui = 0;
                for (let k = 0; k < len / 2; k++) {
                    const vr = re[i + k + len / 2] * ur - im[i + k + len / 2] * ui;
                    const vi = re[i + k + len / 2] * ui + im[i + k + len / 2] * ur;
                    re[i + k + len / 2] = re[i + k] - vr;
                    im[i + k + len / 2] = im[i + k] - vi;
                    re[i + k] += vr;
                    im[i + k] += vi;
                    const nextUr = ur * wlenRe - ui * wlenIm;
                    ui = ur * wlenIm + ui * wlenRe;
                    ur = nextUr;
                }
            }
        }

        // Compute magnitude squared for the first N/2 bins (Nyquist frequency)
        const freqBins = N / 2;
        const mags = new Float32Array(freqBins);
        for (let i = 0; i < freqBins; i++) {
            mags[i] = re[i] * re[i] + im[i] * im[i];
        }
        return mags;
    }

    async function generateSpectrogram(audioUrl) {
        if (!audioUrl) return;

        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const resp = await fetch(audioUrl);
        const arrayBuffer = await resp.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        const canvas = spectrogramCanvas;
        const ctx = canvas.getContext('2d');

        const channelData = audioBuffer.numberOfChannels > 0 ? audioBuffer.getChannelData(0) : audioBuffer.getChannelData(0);
        const totalSamples = channelData.length;

        // Spectrogram parameters
        const fftSize = 4096; // Increased for better frequency resolution ("más preciso")
        const hopSize = 256;  // Decreased for better time resolution ("más preciso")
        const N = fftSize;
        const sampleRate = audioCtx.sampleRate;
        const fullFreqBins = fftSize / 2; // Total number of unique frequency bins for the full range

        // Fixed display height and focus on lower frequencies
        const displayCanvasHeight = SPECTROGRAM_DISPLAY_HEIGHT; // "más aplastado"
        const maxDisplayFrequency = 8000; // Hz - "concentrarse en la parte inferior" (e.g., up to 8kHz)
        // Calculate the highest frequency bin we want to display
        const maxDisplayFreqBin = Math.min(fullFreqBins, Math.floor(maxDisplayFrequency / (sampleRate / fftSize)));

        // Prepare Hann window function once
        const windowFn = new Float32Array(N);
        for (let i = 0; i < N; i++) windowFn[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));

        // Calculate the number of spectrogram columns
        const numColumns = Math.ceil(totalSamples / hopSize);

        // Canvas dimensions for drawing context (actual pixel dimensions)
        canvas.width = numColumns; // Each FFT frame is one pixel wide horizontally
        canvas.height = displayCanvasHeight; // Set to fixed height for drawing

        // Set style width for rendering, accounting for initial zoom and actual height for CSS
        canvas.style.width = `${numColumns * spectrogramZoom}px`;
        canvas.style.height = `${displayCanvasHeight}px`; // Set explicit height for display

        // Prepare an offscreen ImageData column buffer (1px wide)
        const imgData = ctx.createImageData(1, displayCanvasHeight);

        // dB scaling parameters
        const minDb = -80; // Minimum dB value to display
        const maxDb = 0;   // Maximum dB value (0dB typically corresponds to full scale amplitude)
        // Reference magnitude squared for 0dB (amplitude 1.0 after FFT).
        const referenceMagSquared = Math.pow(N / 2, 2);

        // For each column (time slice), compute spectrum and draw it
        for (let col = 0; col < numColumns; col++) {
            const startSample = col * hopSize;
            if (startSample >= totalSamples) break;

            const frame = new Float32Array(N);
            // Fill frame, padding with zeros if end of audio is reached
            for (let k = 0; k < N; k++) {
                const idx = startSample + k;
                frame[k] = (idx < totalSamples) ? channelData[idx] : 0;
            }

            const mags = await fftRealMagSquared(frame, windowFn);

            // Draw vertical line: low freq at bottom (y=displayCanvasHeight), high freq at top (y=0)
            for (let y = 0; y < displayCanvasHeight; y++) {
                // Map y-coordinate to frequency bin (inverted: y=0 -> high freq, y=displayCanvasHeight -> low freq)
                // Using maxDisplayFreqBin to focus on lower frequencies
                const freqBinIndex = Math.floor((1 - (y + 0.5) / displayCanvasHeight) * maxDisplayFreqBin);
                
                // Ensure freqBinIndex is within valid range (0 to maxDisplayFreqBin - 1)
                const safeFreqBinIndex = Math.max(0, Math.min(maxDisplayFreqBin - 1, freqBinIndex));
                
                const magSquared = mags[safeFreqBinIndex] || 0;

                // Convert magnitude squared to dB. Add tiny epsilon to avoid log(0).
                let db = 10 * Math.log10(magSquared / referenceMagSquared + 1e-12);
                db = Math.max(minDb, db); // Clamp values below minDb to minDb

                // Normalize dB value to 0-1 range for color mapping
                const normalizedIntensity = (db - minDb) / (maxDb - minDb);
                const clampedIntensity = Math.max(0, Math.min(1, normalizedIntensity)); // Ensure 0-1 range

                const colRgb = colorMapIntensity(clampedIntensity); // returns [r,g,b]
                const offset = y * 4; // 4 bytes per pixel (RGBA)
                imgData.data[offset] = colRgb[0];
                imgData.data[offset + 1] = colRgb[1];
                imgData.data[offset + 2] = colRgb[2];
                imgData.data[offset + 3] = 255; // Alpha
            }
            ctx.putImageData(imgData, col, 0);
        }

        // Scroll to start and save dataURL
        if (spectrogramBar) spectrogramBar.scrollLeft = 0;
        try {
            const specDataUrl = canvas.toDataURL('image/png');
            saveToCache(CACHE_KEYS.spectrogramImage, specDataUrl);
        } catch (e) {
            console.warn('Could not save spectrogram to cache', e);
        }

        // Update progress line after draw
        requestAnimationFrame(() => {
            const ratio = (audioPreview && audioPreview.duration && isFinite(audioPreview.duration) && audioPreview.duration > 0)
                ? Math.max(0, Math.min(1, (audioPreview.currentTime || 0) / audioPreview.duration))
                : currentProgressRatio || 0;
            setProgressPositionFromRatio(ratio);
        });
    }

    // Maps a normalized intensity value (t from 0 to 1) to an RGB color based on the specified gradient.
    // blue (0, 70, 200), green (0, 200, 80), yellow (240,220,20)
    function colorMapIntensity(t) {
        if (t <= 0) return [10, 20, 40]; // Darkest blue/nearly black for very low intensity
        if (t < 0.5) {
            const u = t / 0.5; // Scale t to 0-1 for the first half of the gradient
            const r = Math.round(0 + (0 - 0) * u);
            const g = Math.round(70 + (200 - 70) * u);
            const b = Math.round(200 + (80 - 200) * u);
            return [r, g, b]; // Interpolate from blue to green
        } else {
            const u = (t - 0.5) / 0.5; // Scale t to 0-1 for the second half of the gradient
            const r = Math.round(0 + (240 - 0) * u);
            const g = Math.round(200 + (20 - 200) * u);
            const b = Math.round(80 + (20 - 80) * u);
            return [r, g, b]; // Interpolate from green to yellow
        }
    }

    // On app start/load, restore any cached items
    function restoreFromCache() {
        // restore scanned text
        const cachedText = loadFromCache(CACHE_KEYS.scannedText);
        if (cachedText && scannedTextOutput) {
            scannedTextOutput.innerHTML = cachedText;
        }
        // restore image
        const cachedImage = loadFromCache(CACHE_KEYS.imageData);
        if (cachedImage) {
            const img = new Image();
            img.onload = () => {
                currentOriginalImage = img;
                updateImagePreview();
            };
            img.src = cachedImage;
        }
        // restore audio
        const cachedAudio = loadFromCache(CACHE_KEYS.audioData);
        if (cachedAudio) {
            audioPreview.src = cachedAudio;
            audioPreviewContainer.style.display = 'block';
            audioReadyButton.style.display = 'inline-block';
            // restore saved filename if available
            const cachedName = loadFromCache(CACHE_KEYS.audioFilename);
            if (cachedName) { audioFileNameBase = cachedName; audioFilename.textContent = cachedName; }
            // If cached audio, also try to generate spectrogram again
            generateSpectrogram(cachedAudio).catch(err => console.error('Spectrogram restoration error', err));
        }
        // restore spectrogram image into canvas
        const cachedSpec = loadFromCache(CACHE_KEYS.spectrogramImage);
        if (cachedSpec && spectrogramCanvas) {
            const img = new Image();
            img.onload = () => {
                spectrogramCanvas.width = img.width;
                // Set fixed height for the canvas when restoring (to ensure "aplastado")
                spectrogramCanvas.height = SPECTROGRAM_DISPLAY_HEIGHT;
                // Set style width with current zoom (default 1)
                spectrogramCanvas.style.width = `${img.width * spectrogramZoom}px`;
                spectrogramCanvas.style.height = `${SPECTROGRAM_DISPLAY_HEIGHT}px`; // Explicitly set style height
                spectrogramCanvas.style.display = 'inline-block';
                const ctxSpec = spectrogramCanvas.getContext('2d');
                ctxSpec.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
                // Draw the cached image, scaling it to fit the new fixed height
                ctxSpec.drawImage(img, 0, 0, img.width, img.height, 0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
                
                // adjust scroll and progress line
                if (spectrogramBar) spectrogramBar.scrollLeft = 0;
                requestAnimationFrame(() => {
                    // ensure we compute using full canvas width
                    setProgressPositionFromRatio(currentProgressRatio || 0);
                });
            };
            img.src = cachedSpec;
        }

        // NEW: restore SRT data
        const cachedSrtJson = loadFromCache(CACHE_KEYS.srtData);
        if (cachedSrtJson) {
            try {
                const cachedSrtData = JSON.parse(cachedSrtJson);
                // Populate the table directly from cached data on load
                populateSrtTable(cachedSrtData);
                // Draw regions after a short delay to ensure audio and spectrogram might be loaded
                setTimeout(drawSrtRegions, 100);
            } catch (e) {
                console.error('Error parsing cached SRT data:', e);
                saveToCache(CACHE_KEYS.srtData, null); // Clear invalid cache
            }
        }
        updateCacheStatus();
    }

    // --- SRT helper functions (added) ---
    function formatTime(ms) {
        const totalMs = Math.max(0, Math.round(ms));
        const hours = Math.floor(totalMs / 3600000);
        const minutes = Math.floor((totalMs % 3600000) / 60000);
        const seconds = Math.floor((totalMs % 60000) / 1000);
        const milliseconds = totalMs % 1000;
        return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')},${String(milliseconds).padStart(3,'0')}`;
    }

    function saveSrtTableToCache() {
        if (!srtTableBody) return;
        const rows = Array.from(srtTableBody.querySelectorAll('tr')).map((tr, i) => {
            const cols = tr.querySelectorAll('td');
            return {
                index: i,
                startMs: Number(cols[1]?.dataset.time || 0),
                endMs: Number(cols[2]?.dataset.time || 0),
                text: cols[3]?.innerText || ''
            };
        });
        saveToCache(CACHE_KEYS.srtData, JSON.stringify(rows));
    }

    function populateSrtTable(srtArray) {
        if (!srtTableBody) return;
        srtTableBody.innerHTML = '';
        srtArray.forEach((item, i) => {
            const tr = document.createElement('tr');
            const idxTd = document.createElement('td');
            idxTd.textContent = i + 1;
            const startTd = document.createElement('td');
            startTd.dataset.time = Number(item.startMs || 0);
            startTd.textContent = formatTime(startTd.dataset.time);
            const endTd = document.createElement('td');
            endTd.dataset.time = Number(item.endMs || 0);
            endTd.textContent = formatTime(endTd.dataset.time);
            const contentTd = document.createElement('td');
            contentTd.className = 'editable-content';
            contentTd.contentEditable = true;
            contentTd.innerText = item.text || '';
            tr.appendChild(idxTd);
            tr.appendChild(startTd);
            tr.appendChild(endTd);
            tr.appendChild(contentTd);
            srtTableBody.appendChild(tr);
        });
        saveSrtTableToCache();
        // redraw regions to reflect new table
        drawSrtRegions();
    }

    // Generate a basic SRT table from the scanned text: splits lines and assigns sequential intervals (2s each) across audio duration if available.
    function generateSrtTableFromScannedText() {
        if (!srtTableBody) return;
        const rawHtml = scannedTextOutput ? scannedTextOutput.innerHTML : '';
        const temp = document.createElement('div');
        temp.innerHTML = rawHtml;
        temp.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        const lines = Array.from(temp.childNodes).map(n => n.nodeType === Node.TEXT_NODE ? n.nodeValue : n.innerText).join('\n')
            .split(/\r?\n/).map(l => l.replace(/\u00A0/g,' ').trim()).filter(l => l.length > 0);
        const durationMs = (audioPreview && audioPreview.duration && isFinite(audioPreview.duration)) ? audioPreview.duration * 1000 : Math.max(2000, lines.length * 2000);
        const defaultPerLine = Math.floor(durationMs / Math.max(1, lines.length));
        const srtArray = lines.map((text, i) => {
            const startMs = i * defaultPerLine;
            const endMs = Math.min(durationMs, startMs + defaultPerLine);
            return { index: i, startMs, endMs, text };
        });
        populateSrtTable(srtArray);
        saveSrtTableToCache();

        // If audio metadata (duration) is available, redistribute the table within [10s, duration-5s]
        // so the regions' start/end times are evenly distributed within that internal window.
        if (audioPreview && audioPreview.duration && isFinite(audioPreview.duration)) {
            redistributeSrtRegionsToAudioWindow();
        }
    }

    // History utilities
    function loadHistory() {
        const raw = loadFromCache(CACHE_KEYS.history);
        if (!raw) return [];
        try { return JSON.parse(raw); } catch(e){ return []; }
    }
    function saveHistoryArray(arr) {
        saveToCache(CACHE_KEYS.history, JSON.stringify(arr || []));
    }
    function saveHistoryItem() {
        // Build item: srt array + audio data + audio filename + timestamp
        if (!srtTableBody) return;
        const rows = Array.from(srtTableBody.querySelectorAll('tr')).map((tr, i) => {
            return { index: i, startMs: Number(tr.children[1]?.dataset.time || 0), endMs: Number(tr.children[2]?.dataset.time || 0), text: tr.children[3]?.innerText || '' };
        });
        const audioDataUrl = loadFromCache(CACHE_KEYS.audioData) || (audioPreview && audioPreview.src) || null;
        const audioName = loadFromCache(CACHE_KEYS.audioFilename) || audioFileNameBase || 'subtitles';
        const item = {
            id: 'h_' + Date.now(),
            created: Date.now(),
            title: audioName,
            audioName,
            audioDataUrl,
            srt: rows
        };
        const arr = loadHistory();
        arr.unshift(item); // newest first
        saveHistoryArray(arr);
        renderHistory();
        updateCacheStatus();
        alert('Trabajo agregado al historial.');
    }

    function renderHistory(filter = '') {
        const list = document.getElementById('history-list');
        if (!list) return;
        const arr = loadHistory();
        list.innerHTML = '';
        const q = (filter || '').toLowerCase().trim();
        arr.filter(it => !q || (it.title && it.title.toLowerCase().includes(q)) || (it.srt && it.srt.some(s => s.text && s.text.toLowerCase().includes(q))))
           .forEach(it => {
               const el = document.createElement('div');
               el.className = 'history-item';
               const meta = document.createElement('div');
               meta.className = 'history-meta';
               const title = document.createElement('div');
               title.className = 'history-title';
               title.textContent = it.title || ('Trabajo ' + new Date(it.created).toLocaleString());
               const sub = document.createElement('div');
               sub.className = 'history-sub';
               sub.textContent = new Date(it.created).toLocaleString();
               meta.appendChild(title);
               meta.appendChild(sub);

               const actions = document.createElement('div');
               actions.className = 'history-actions';
               const dlBtn = document.createElement('button');
               dlBtn.className = 'action-button';
               dlBtn.textContent = 'Descargar SRT';
               dlBtn.addEventListener('click', () => {
                   const srtText = (it.srt || []).map((r,i)=> `${i+1}\n${formatTime(r.startMs)} --> ${formatTime(r.endMs)}\n${(r.text||'')}\n`).join('\n');
                   const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
                   const url = URL.createObjectURL(blob);
                   const a = document.createElement('a');
                   a.href = url;
                   a.download = `${it.audioName || 'subtitles'}.srt`;
                   document.body.appendChild(a);
                   a.click();
                   a.remove();
                   URL.revokeObjectURL(url);
               });
               const editBtn = document.createElement('button');
               editBtn.className = 'action-button primary';
               editBtn.textContent = 'Editar';
               editBtn.addEventListener('click', () => {
                   // Load into app: set audio preview and srt table, navigate to modificar-srt-section
                   if (it.audioDataUrl && audioPreview) {
                       audioPreview.src = it.audioDataUrl;
                       audioPreviewContainer.style.display = 'block';
                       audioReadyButton.style.display = 'inline-block';
                       saveToCache(CACHE_KEYS.audioData, it.audioDataUrl);
                       saveToCache(CACHE_KEYS.audioFilename, it.audioName || 'subtitles');
                       audioFileNameBase = it.audioName || 'subtitles';
                   }
                   populateSrtTable(it.srt || []);
                   const modificarBtn = document.querySelector('.sidebar-button[data-section="modificar-srt"]');
                   if (modificarBtn) updateActiveButton(modificarBtn);
                   renderSection('modificar-srt-section');
               });

               actions.appendChild(dlBtn);
               actions.appendChild(editBtn);

               el.appendChild(meta);
               el.appendChild(actions);
               list.appendChild(el);
           });
    }

    // wire up add-to-history button & search input
    const addToHistoryButton = document.getElementById('add-to-history-button');
    if (addToHistoryButton) {
        addToHistoryButton.addEventListener('click', () => {
            // save current SRT+audio as history item
            saveHistoryItem();
        });
    }
    const historySearch = document.getElementById('history-search');
    if (historySearch) {
        historySearch.addEventListener('input', (e) => {
            renderHistory(e.target.value);
        });
    }

    // call restore on load
    restoreFromCache();
    renderHistory();

    // Hook up Reiniciar button to show confirmation modal (do not remove history)
    const resetCacheButton = document.getElementById('reset-cache-button');
    const confirmClearModal = document.getElementById('confirm-clear-modal');
    const confirmClearYes = document.getElementById('confirm-clear-yes');
    const confirmClearCancel = document.getElementById('confirm-clear-cancel');

    if (resetCacheButton) {
        resetCacheButton.addEventListener('click', () => {
            if (confirmClearModal) {
                confirmClearModal.classList.remove('hidden');
                confirmClearModal.setAttribute('aria-hidden', 'false');
            } else {
                // fallback to direct clear
                doClearCacheAndResetUI();
            }
        });
    }
    if (confirmClearCancel) {
        confirmClearCancel.addEventListener('click', () => {
            if (confirmClearModal) {
                confirmClearModal.classList.add('hidden');
                confirmClearModal.setAttribute('aria-hidden', 'true');
            }
        });
    }
    if (confirmClearYes) {
        confirmClearYes.addEventListener('click', () => {
            if (confirmClearModal) {
                confirmClearModal.classList.add('hidden');
                confirmClearModal.setAttribute('aria-hidden', 'true');
            }
            doClearCacheAndResetUI();
        });
    }

    function doClearCacheAndResetUI() {
        // Remove stored data (but keep history)
        clearCache();
        // Reset UI fields
        // scanned text
        if (scannedTextOutput) scannedTextOutput.innerHTML = '';
        // image
        currentOriginalImage = null;
        if (imagePreview) { imagePreview.src = '#'; imagePreview.style.display = 'none'; }
        if (imagePreviewContainer) imagePreviewContainer.style.display = 'flex';
        // audio
        if (audioPreview) {
            audioPreview.pause();
            audioPreview.removeAttribute('src');
            audioPreview.load();
            audioPreviewContainer.style.display = 'none';
        }
        if (audioFilename) audioFilename.textContent = '';
        if (audioReadyButton) audioReadyButton.style.display = 'none';
        // spectrogram
        if (spectrogramCanvas) {
            const ctxSpec = spectrogramCanvas.getContext('2d');
            ctxSpec.clearRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
            // Reset canvas dimensions and style to clear visual, using fixed height
            spectrogramCanvas.width = 1;
            spectrogramCanvas.height = SPECTROGRAM_DISPLAY_HEIGHT; 
            spectrogramCanvas.style.width = '1px';
            spectrogramCanvas.style.height = `${SPECTROGRAM_DISPLAY_HEIGHT}px`;
            spectrogramCanvas.style.display = 'inline-block';
        }
        // reset zoom to default
        spectrogramZoom = 1;
        // reset progress line
        resetProgressLine();
        // Clear SRT table content
        if (srtTableBody) srtTableBody.innerHTML = '';
        // NEW: Clear SRT regions
        if (spectrogramRegionsContainer) spectrogramRegionsContainer.innerHTML = '';
        // Also explicitly clear the SRT cache
        saveToCache(CACHE_KEYS.srtData, null);
        // Ensure uploaded images and gallery are cleared when resetting cache
        imageGalleryItems = [];
        if (imageGallery) imageGallery.innerHTML = '';
        currentOriginalImage = null;
        if (imagePreview) { imagePreview.src = '#'; imagePreview.style.display = 'none'; }
        updateCacheStatus();
    }

    // NEW: function to play last 2s of selected region
    async function playLastTwoSecondsOfRegion() {
        if (selectedSrtIndex === null || !audioPreview) return;
        // Keep region watcher active so playback will dynamically respect the region end while it is edited.
        suppressRegionEnforcement = false;

        const rows = srtTableBody.querySelectorAll('tr');
        const row = rows[selectedSrtIndex];
        if (!row) return;

        const startMs = parseFloat(row.children[1].dataset.time) || 0;
        const endMs = parseFloat(row.children[2].dataset.time) || 0;

        // Calculate the start time for playback: 2 seconds before the end, but not before the region's start.
        const playbackStartMs = Math.max(startMs, endMs - 2000);
        
        // Ensure normal region enforcement is active so it stops at the end
        // Set time and play, then explicitly start the dynamic watcher so edits to the end are respected.
        audioPreview.currentTime = playbackStartMs / 1000;
        try {
            await audioPreview.play();
            startRegionWatcher();
        } catch(e) {
            console.warn('Playback initiation failed', e);
        }
    }

    // NEW: handle 'd' key to play 2s past selected region then return and pause
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isTyping = active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable
        );
        if (isTyping) return;

        if (e.key.toLowerCase() === 'd') {
            e.preventDefault();
            playTwoSecondsPastAndReturn();
        }

        // NEW: handle 's' key to play last 2s of selected region
        if (e.key.toLowerCase() === 's') {
            e.preventDefault();
            playLastTwoSecondsOfRegion();
        }
    });

    // NEW: 'g' and 'h' snap helpers: g -> snap left to previous end +20ms; h -> snap right to next start -20ms
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isTyping = active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable
        );
        if (isTyping) return;
        if (selectedSrtIndex === null) return;
        const rows = srtTableBody.querySelectorAll('tr');
        const idx = selectedSrtIndex;
        if (e.key.toLowerCase() === 'e') {
            e.preventDefault();
            const prev = rows[idx-1];
            const prevEnd = prev ? Number(prev.children[2].dataset.time) : 0;
            const newStart = Math.min(Number(rows[idx].children[2].dataset.time)-1, prevEnd + 20); // ensure start < end
            updateTimeCellsAndCache(idx, Math.max(0, newStart), Number(rows[idx].children[2].dataset.time));
            drawSrtRegions();
        } else if (e.key.toLowerCase() === 'r') {
            e.preventDefault();
            const next = rows[idx+1];
            const nextStart = next ? Number(next.children[1].dataset.time) : (audioPreview && audioPreview.duration ? audioPreview.duration*1000 : Number(rows[idx].children[2].dataset.time));
            const newEnd = Math.max(Number(rows[idx].children[1].dataset.time)+1, nextStart - 20); // ensure end > start
            updateTimeCellsAndCache(idx, Number(rows[idx].children[1].dataset.time), Math.min(nextStart, newEnd));
            drawSrtRegions();
        }
    });

    // Play 2s past selected region end, then pause and return to region end
    async function playTwoSecondsPastAndReturn() {
        if (selectedSrtIndex === null || !audioPreview) return;
        stopRegionWatcher(); // Stop any existing watchers
        
        const rows = srtTableBody.querySelectorAll('tr');
        const row = rows[selectedSrtIndex];
        if (!row) return;

        const endMs = parseFloat(row.children[2].dataset.time) || 0;
        const duration = (audioPreview.duration && isFinite(audioPreview.duration)) ? audioPreview.duration * 1000 : 0;
        if (duration === 0) return;

        const targetMs = Math.min(duration, endMs + 2000);
        
        // Temporarily disable region enforcement so audio can play past the region boundary
        suppressRegionEnforcement = true;

        let onTimeRaf = null;
        const onTime = () => {
            const nowMs = (audioPreview.currentTime || 0) * 1000;
            if (nowMs >= targetMs || audioPreview.paused) {
                audioPreview.pause();
                audioPreview.currentTime = endMs / 1000;
                if(onTimeRaf) cancelAnimationFrame(onTimeRaf);
                // restore normal region enforcement after finishing
                suppressRegionEnforcement = false;
            } else {
               onTimeRaf = requestAnimationFrame(onTime);
            }
        };
        
        // Start playing from the region's end.
        audioPreview.currentTime = endMs / 1000;
        try { 
            await audioPreview.play();
            // Start the watcher *after* play begins
            onTimeRaf = requestAnimationFrame(onTime);
        } catch(e){ 
            suppressRegionEnforcement = false;
        }
    }

    // Download SRT creation & UI
    const downloadSrtButton = document.getElementById('download-srt-button');
    const downloadProgress = document.getElementById('download-progress');
    const downloadProgressBar = document.getElementById('download-progress-bar');

    function buildSrtTextFromTable() {
        if (!srtTableBody) return '';
        const rows = Array.from(srtTableBody.querySelectorAll('tr'));
        return rows.map((tr, i) => {
            const idx = i + 1;
            const start = tr.children[1]?.dataset.time || 0;
            const end = tr.children[2]?.dataset.time || 0;
            const text = (tr.children[3]?.innerText || '').replace(/\r/g,'').trim();
            // Convert ms to SRT time format already stored as formatted text in cells, but use dataset times for precision
            const startStr = formatTime(Number(start));
            const endStr = formatTime(Number(end));
            return `${idx}\n${startStr} --> ${endStr}\n${text}\n`;
        }).join('\n');
    }

    async function simulateProgressDuring(callback) {
        // show progress UI and simulate a smooth progression while running the callback
        if (!downloadProgress || !downloadProgressBar) return await callback();
        downloadProgress.style.display = 'block';
        downloadProgressBar.style.width = '4%';
        // small async progression loop
        const autoInc = () => {
            const cur = parseFloat(downloadProgressBar.style.width);
            const next = Math.min(96, cur + (1 + Math.random()*6));
            downloadProgressBar.style.width = `${next}%`;
            return next < 96;
        };
        let active = true;
        const runner = setInterval(() => { if (!autoInc()) { clearInterval(runner); } }, 120);
        try {
            const res = await callback();
            clearInterval(runner);
            downloadProgressBar.style.width = '100%';
            await new Promise(r => setTimeout(r,120)); // brief pause to show completion
            downloadProgress.style.display = 'none';
            downloadProgressBar.style.width = '0%';
            return res;
        } catch (e) {
            clearInterval(runner);
            downloadProgress.style.display = 'none';
            downloadProgressBar.style.width = '0%';
            throw e;
        }
    }

    if (downloadSrtButton) {
        downloadSrtButton.addEventListener('click', async () => {
            // ensure cache is up to date
            saveSrtTableToCache();
            const srtText = buildSrtTextFromTable();
            if (!srtText) { alert('No hay datos SRT para descargar.'); return; }
            try {
                await simulateProgressDuring(async () => {
                    // small artificial delay to improve UX on quick builds
                    await new Promise(r => setTimeout(r, 150));
                });
                const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                // Use uploaded audio filename base, fallback to 'subtitles'
                a.href = url;
                a.download = `${audioFileNameBase || 'subtitles'}.srt`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error('Error building/downloading SRT', err);
                alert('Ocurrió un error al generar el archivo SRT.');
            }
        });
    }

    // Space toggles play/pause (when not focused on an input or editable area)
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isTyping = active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable
        );
        if (e.code === 'Space' && !isTyping) {
            e.preventDefault();
            if (!audioPreview.src) return;

            // Ensure playback by space always respects region limits
            suppressRegionEnforcement = false;

            // If a region is selected, Space always restarts from the region's start
            if (selectedSrtIndex !== null) {
                const rows = srtTableBody.querySelectorAll('tr');
                const row = rows[selectedSrtIndex];
                if (row) {
                    const startMs = parseFloat(row.children[1].dataset.time) || 0;
                    audioPreview.currentTime = startMs / 1000;
                    audioPreview.play().catch(()=>{});
                    startRegionWatcher();
                    return;
                }
            }

            // Default behavior when no region selected: toggle play/pause
            if (audioPreview.paused) {
                audioPreview.play().catch(()=>{});
            } else {
                audioPreview.pause();
            }
        }
    });

    // NEW: keyboard navigation for SRT region selection:
    // Enter or ArrowRight -> next region; ArrowLeft -> previous region.
    // Respects editing contexts (won't intercept typing).
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isTyping = active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable
        );
        if (isTyping) return; // don't interfere while typing/editing

        if (selectedSrtIndex === null) return; // only navigate when a region is currently selected

        const rows = srtTableBody ? srtTableBody.querySelectorAll('tr') : [];
        const lastIndex = Math.max(0, rows.length - 1);

        if (e.key === 'Enter' || e.key === 'ArrowRight' || e.key.toLowerCase() === 'w') {
            e.preventDefault();
            const next = Math.min(lastIndex, selectedSrtIndex + 1);
            if (next !== selectedSrtIndex) selectRegionByIndex(next);
        } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'q') {
            e.preventDefault();
            const prev = Math.max(0, selectedSrtIndex - 1);
            if (prev !== selectedSrtIndex) selectRegionByIndex(prev);
        }
    });

    audioPreview.addEventListener('play', () => {
        // When playback starts, ensure the region watcher is active if a region is selected.
        startRegionWatcher();
    });
    audioPreview.addEventListener('pause', () => {
        // When playback stops, also stop the watcher.
        stopRegionWatcher();
    });

    audioPreview.addEventListener('timeupdate', () => {
        // The watcher now handles region enforcement. This listener is only for the progress line.
        updateProgressLine();
    });
});