import { auth, db } from './connect.js';
import {
    collection,
    addDoc,
    updateDoc,
    deleteDoc,
    doc,
    getDocs,
    getDoc,
    query,
    where,
    orderBy,
    serverTimestamp,
    writeBatch,
    increment,
    limit
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

import { showToast } from './auth.js';
import { currentUser, userRole } from './dashboard.js';

export function debounce(func, delay) {
    let timeout;
    return function (...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

// Global variables
let currentImportItems = [];
let currentEditingId = null;
let currentExportItems = [];
let pendingItemCodeFilter = null;
let isScanningForExport = false;

let itemCodeCache = new Map();
let unitCache = new Set(['Cái', 'Chiếc', 'Bộ', 'Hộp', 'Thùng', 'Cuộn', 'Tấm', 'Túi', 'Gói', 'Chai', 'Lọ', 'Lon', 'Bao', 'Kg', 'Gam', 'Tấn', 'Mét', 'Cây', 'Thanh', 'Đôi']);
let categoryCache = new Set();

// Initialize warehouse functions
document.addEventListener('DOMContentLoaded', function () {
    initializeWarehouseFunctions();
});

export async function loadCacheData() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'));
        const snapshot = await getDocs(inventoryQuery);

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.code) {
                itemCodeCache.set(data.code, {
                    name: data.name,
                    unit: data.unit,
                    category: data.category,
                    location: data.location
                });

                if (data.unit) unitCache.add(data.unit);
                if (data.category) categoryCache.add(data.category);
            }
        });
    } catch (error) {
        console.error('Error loading cache data:', error);
    }
}

let listenersInitialized = false; // Flag để đảm bảo chỉ chạy một lần

function forceUIRefresh() {
    // Hàm này trả về một Promise được giải quyết sau một "tick" của Event Loop.
    // Điều này cho phép trình duyệt có thời gian để xử lý và "vẽ" lại các thay đổi DOM.
    return new Promise(resolve => setTimeout(resolve, 0));
}

export function initializeWarehouseFunctions() {
    // Nếu các trình lắng nghe đã được thiết lập, không thực hiện lại.
    if (listenersInitialized) {
        return;
    }

    // ---- Các nút hành động chính ----
    document.getElementById('addImportBtn')?.addEventListener('click', showImportModal);
    document.getElementById('addExportBtn')?.addEventListener('click', showExportModal);
    document.getElementById('addTransferBtn')?.addEventListener('click', showTransferModal);
    if (userRole === 'super_admin') {
        document.getElementById('addAdjustBtn')?.addEventListener('click', showDirectAdjustModal);
    } else if (userRole === 'admin') {
        document.getElementById('addAdjustRequestBtn')?.addEventListener('click', showAdjustRequestModal);
    }

    // ---- Các trình lắng nghe được tập trung hóa cho Filter và Excel ----
    initializeFilters();
    initializeExcelFunctions(); // Chúng ta sẽ tạo hàm này tiếp theo để nhóm logic Excel

    // Đánh dấu là đã khởi tạo
    listenersInitialized = true;
}


function removeExistingListeners() {
    // Clone and replace elements to remove all event listeners
    const buttonsToClean = [
        'addImportBtn', 'downloadTemplate', 'importExcel',
        'addExportBtn', 'downloadExportTemplate', 'importExportExcel',
        'addTransferBtn', 'downloadTransferTemplate', 'importTransferExcel',
        'addAdjustBtn', 'downloadAdjustTemplate', 'importAdjustExcel',
        'addAdjustRequestBtn', 'downloadRequestAdjustTemplate', 'importRequestAdjustExcel'
    ];

    buttonsToClean.forEach(buttonId => {
        const button = document.getElementById(buttonId);
        if (button) {
            const newButton = button.cloneNode(true);
            button.parentNode.replaceChild(newButton, button);
        }
    });

    // Also clean file inputs
    const fileInputsToClean = [
        'excelFileInput', 'exportExcelFileInput', 'transferExcelFileInput',
        'adjustExcelFileInput', 'requestAdjustExcelFileInput'
    ];

    fileInputsToClean.forEach(inputId => {
        const input = document.getElementById(inputId);
        if (input) {
            const newInput = input.cloneNode(true);
            input.parentNode.replaceChild(newInput, input);
        }
    });
}

// Import Section Functions
export function loadImportSection() {
    loadImportHistory();
}

// Thay thế hàm này trong warehouse.js

function showImportModal() {
    const lastFocusedElement = document.activeElement;
    // Reset danh sách hàng hóa mỗi khi mở
    currentImportItems = [];

    const modal = createImportModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        // Tự động focus vào ô nhập liệu đầu tiên
        document.getElementById('importNumber').focus();
    });

    modal.addEventListener('hidden.bs.modal', () => {
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
        modal.remove();
    });

    bsModal.show();
}

function createImportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'importModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-success text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-download"></i> Tạo phiếu nhập kho
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="importForm" onsubmit="return false;">
                        <!-- THÔNG TIN PHIẾU -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-file-alt"></i>
                                Thông tin phiếu nhập
                            </div>
                            <div class="row">
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-hashtag text-primary"></i>
                                            Số phiếu nhập <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="importNumber" required>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-truck text-primary"></i>
                                            Nhà cung cấp <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="supplier" required>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- THÊM MẶT HÀNG - COMPACT VERSION -->
                        <div class="form-section-compact form-section-collapsible" id="addItemSection">
                            <div class="form-section-header-compact">
                                <i class="fas fa-plus-circle"></i>
                                Thêm mặt hàng
                                <button type="button" class="collapse-toggle" onclick="toggleAddItemSection()">
                                    <i class="fas fa-chevron-up" id="collapseIcon"></i> Thu gọn
                                </button>
                            </div>
                            <div class="form-section-body">
                                <!-- Hàng 1: Thông tin cơ bản -->
                                <div class="row quick-add-row mb-2">
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-barcode text-primary"></i> Mã hàng *
                                        </label>
                                        <div class="autocomplete-container-compact">
                                            <input type="text" class="form-control-compact" id="newItemCode" 
                                                   placeholder="Mã hàng..." autocomplete="off">
                                            <div class="suggestion-dropdown-compact" id="itemCodeSuggestions" style="display: none;"></div>
                                        </div>
                                        <div id="itemStatus"></div>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-tag text-primary"></i> Tên mô tả *
                                        </label>
                                        <input type="text" class="form-control-compact" id="newItemName" 
                                               placeholder="Tên sản phẩm..." required>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-sort-numeric-up text-primary"></i> SL *
                                        </label>
                                        <input type="number" class="form-control-compact" id="newItemQuantity" 
                                               placeholder="0" required min="0" step="1">
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-ruler text-primary"></i> Đơn vị *
                                        </label>
                                        <select class="form-select-compact" id="newItemUnit" required>
                                            <option value="">Chọn...</option>
                                        </select>
                                        <div class="unit-selector-compact" id="unitSelector"></div>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-list text-primary"></i> Danh mục *
                                        </label>
                                        <div class="autocomplete-container-compact">
                                            <input type="text" class="form-control-compact" id="newItemCategory" 
                                                   placeholder="Danh mục..." required autocomplete="off">
                                            <div class="suggestion-dropdown-compact" id="categorySuggestions" style="display: none;"></div>
                                        </div>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-map-marker-alt text-primary"></i> Vị trí *
                                        </label>
                                        <input type="text" class="form-control-compact" id="newItemLocation" 
                                               placeholder="A1-01" required>
                                    </div>
                                </div>

                                <!-- Hàng 2: Đơn vị tùy chỉnh và nút thêm -->
                                <div class="row align-items-end">
                                    <div class="col-md-3">
                                        <div class="d-flex gap-1">
                                            <button type="button" class="add-unit-btn" onclick="toggleCustomUnitInput()" title="Thêm đơn vị mới">
                                                <i class="fas fa-plus"></i> Đơn vị
                                            </button>
                                            <div class="custom-unit-container" id="customUnitContainer" style="display: none;">
                                                <input type="text" class="form-control-compact" id="customUnitInput" 
                                                       placeholder="Đơn vị mới..." maxlength="20" style="width: 80px;">
                                                <button type="button" class="btn btn-sm btn-success" onclick="addCustomUnit()" style="height: 32px;">
                                                    <i class="fas fa-check"></i>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="col-md-6">
                                        <small class="text-muted">
                                            <i class="fas fa-lightbulb"></i> 
                                            Nhập mã hàng để tự động điền thông tin có sẵn
                                        </small>
                                    </div>
                                    <div class="col-md-3 text-end">
                                        <button type="button" class="btn btn-primary btn-sm" onclick="addItemToImportList()">
                                            <i class="fas fa-plus"></i> Thêm vào danh sách
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- DANH SÁCH HÀNG HÓA -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-list-ul"></i>
                                Danh sách hàng hóa nhập kho
                                <span class="badge bg-primary ms-auto" id="itemCountBadge">0 mặt hàng</span>
                            </div>
                            <div class="table-responsive">
                                <table class="table table-bordered table-compact">
                                    <thead class="table-success">
                                        <tr>
                                            <th style="width: 12%">Mã hàng</th>
                                            <th style="width: 28%">Tên mô tả</th>
                                            <th style="width: 8%">SL</th>
                                            <th style="width: 8%">Đơn vị</th>
                                            <th style="width: 18%">Danh mục</th>
                                            <th style="width: 16%">Vị trí</th>
                                            <th style="width: 10%">Thao tác</th>
                                        </tr>
                                    </thead>
                                    <tbody id="importItemsTable">
                                        <tr id="emptyTableRow">
                                            <td colspan="7" class="text-center text-muted py-3">
                                                <i class="fas fa-inbox fa-lg mb-1"></i><br>
                                                <small>Chưa có mặt hàng nào. Thêm mặt hàng ở phía trên.</small>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-success" onclick="saveImport()" id="saveImportBtn" disabled>
                        <i class="fas fa-save"></i> Lưu phiếu nhập
                    </button>
                </div>
            </div>
        </div>
    `;

    // Setup event listeners after modal creation
    setTimeout(() => {
        setupImportModalEventListeners();
    }, 0);

    return modal;
}

// Toggle add item section
window.toggleAddItemSection = function () {
    const section = document.getElementById('addItemSection');
    const icon = document.getElementById('collapseIcon');
    const toggle = document.querySelector('.collapse-toggle');

    const isCollapsed = section.classList.contains('collapsed');

    if (isCollapsed) {
        section.classList.remove('collapsed');
        icon.className = 'fas fa-chevron-up';
        toggle.innerHTML = '<i class="fas fa-chevron-up" id="collapseIcon"></i> Thu gọn';
    } else {
        section.classList.add('collapsed');
        icon.className = 'fas fa-chevron-down';
        toggle.innerHTML = '<i class="fas fa-chevron-down" id="collapseIcon"></i> Mở rộng';
    }
};

// Auto-collapse after adding item
function autoCollapseAfterAdd() {
    const section = document.getElementById('addItemSection');
    if (!section.classList.contains('collapsed')) {
        setTimeout(() => {
            toggleAddItemSection();
        }, 500);
    }
}

function setupImportModalEventListeners() {
    const itemCodeInput = document.getElementById('newItemCode');
    const categoryInput = document.getElementById('newItemCategory');

    // Item code autocomplete
    if (itemCodeInput) {
        itemCodeInput.addEventListener('input', handleItemCodeAutocomplete);
        itemCodeInput.addEventListener('blur', () => {
            setTimeout(() => hideSuggestions('itemCodeSuggestions'), 200);
        });
    }

    // Category autocomplete
    if (categoryInput) {
        categoryInput.addEventListener('input', handleCategoryAutocomplete);
        categoryInput.addEventListener('blur', () => {
            setTimeout(() => hideSuggestions('categorySuggestions'), 200);
        });
    }

    // Load units into selector
    loadUnitsIntoSelector();

    // Load import number auto-suggestion
    suggestImportNumber();
}

function updateSaveButtonState() {
    const saveBtn = document.getElementById('saveImportBtn');
    const hasItems = currentImportItems.length > 0;
    const hasBasicInfo = document.getElementById('importNumber').value.trim() &&
        document.getElementById('supplier').value.trim();

    saveBtn.disabled = !(hasItems && hasBasicInfo);
}

// Suggest import number
function suggestImportNumber() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = today.toTimeString().slice(0, 5).replace(':', '');
    const suggested = `NK${dateStr}${timeStr}`;

    document.getElementById('importNumber').placeholder = `Gợi ý: ${suggested}`;
}

function hideSuggestions(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

// Load units into selector and dropdown
function loadUnitsIntoSelector() {
    const unitSelect = document.getElementById('newItemUnit');
    const unitSelector = document.getElementById('unitSelector');

    // Clear existing options
    unitSelect.innerHTML = '<option value="">-- Chọn đơn vị --</option>';
    unitSelector.innerHTML = '';

    // Common units for quick selection
    const commonUnits = ['Cái', 'Hộp', 'Kg', 'Mét'];

    // Add to dropdown
    Array.from(unitCache).sort().forEach(unit => {
        const option = document.createElement('option');
        option.value = unit;
        option.textContent = unit;
        unitSelect.appendChild(option);
    });

    // Add common units as buttons
    commonUnits.forEach(unit => {
        if (unitCache.has(unit)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'unit-option';
            button.textContent = unit;
            button.onclick = () => selectUnit(unit);
            unitSelector.appendChild(button);
        }
    });
}

window.addCustomUnit = function () {
    const input = document.getElementById('customUnitInput');
    const newUnit = input.value.trim();

    if (!newUnit) {
        showToast('Vui lòng nhập tên đơn vị', 'warning');
        return;
    }

    if (unitCache.has(newUnit)) {
        showToast('Đơn vị này đã tồn tại', 'warning');
        return;
    }

    // Add to cache and reload selector
    unitCache.add(newUnit);
    loadUnitsIntoSelector();
    selectUnit(newUnit);

    // Clear and hide custom input
    input.value = '';
    document.getElementById('customUnitContainer').style.display = 'none';

    showToast(`Đã thêm đơn vị "${newUnit}"`, 'success');
};

// Cập nhật hàm addItemToImportList
window.addItemToImportList = function () {
    const code = document.getElementById('newItemCode').value.trim();
    const name = document.getElementById('newItemName').value.trim();
    const quantity = parseInt(document.getElementById('newItemQuantity').value);
    const unit = document.getElementById('newItemUnit').value;
    const category = document.getElementById('newItemCategory').value.trim();
    const location = document.getElementById('newItemLocation').value.trim();

    // Validation
    if (!code || !name || !quantity || !unit || !category || !location) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    if (quantity <= 0) {
        showToast('Số lượng phải lớn hơn 0', 'warning');
        return;
    }

    // Check if item already in list
    const existingIndex = currentImportItems.findIndex(item => item.code === code);
    if (existingIndex >= 0) {
        const confirmed = confirm(`Mã hàng "${code}" đã có trong danh sách. Bạn có muốn cộng dồn số lượng?`);
        if (confirmed) {
            currentImportItems[existingIndex].quantity += quantity;
        } else {
            return;
        }
    } else {
        // Add new item
        currentImportItems.push({
            code, name, quantity, unit, category, location
        });
    }

    // Update cache if new item
    if (!itemCodeCache.has(code)) {
        itemCodeCache.set(code, { name, unit, category, location });
    }
    categoryCache.add(category);
    unitCache.add(unit);

    // Update UI
    updateImportItemsTable();
    clearImportForm();
    updateSaveButtonState();

    // Auto-collapse section after adding item
    autoCollapseAfterAdd();

    showToast(`Đã thêm "${name}" vào danh sách`, 'success');
};


function clearImportForm() {
    document.getElementById('newItemCode').value = '';
    clearItemFields();
    document.getElementById('newItemQuantity').value = '';
    updateItemStatus('');
    document.getElementById('newItemCode').focus();
}

window.toggleCustomUnitInput = function () {
    const container = document.getElementById('customUnitContainer');
    const isVisible = container.style.display !== 'none';

    container.style.display = isVisible ? 'none' : 'flex';

    if (!isVisible) {
        document.getElementById('customUnitInput').focus();
    }
};

function handleCategoryAutocomplete(event) {
    const value = event.target.value.trim();

    if (value.length === 0) {
        hideSuggestions('categorySuggestions');
        return;
    }

    const suggestions = Array.from(categoryCache)
        .filter(category => category.toLowerCase().includes(value.toLowerCase()))
        .slice(0, 5);

    if (suggestions.length > 0) {
        showCategorySuggestions(suggestions);
    } else {
        hideSuggestions('categorySuggestions');
    }
}

window.selectCategory = function (category) {
    document.getElementById('newItemCategory').value = category;
    hideSuggestions('categorySuggestions');
};

function showCategorySuggestions(suggestions) {
    const dropdown = document.getElementById('categorySuggestions');

    dropdown.innerHTML = suggestions.map(category =>
        `<div class="suggestion-item" onclick="selectCategory('${category}')">${category}</div>`
    ).join('');

    dropdown.style.display = 'block';
}

function handleItemCodeAutocomplete(event) {
    const input = event.target;
    const value = input.value.trim().toUpperCase();
    input.value = value;

    if (value.length === 0) {
        hideSuggestions('itemCodeSuggestions');
        clearItemFields();
        updateItemStatus('');
        return;
    }

    // Check if exact match exists
    if (itemCodeCache.has(value)) {
        const itemData = itemCodeCache.get(value);
        fillItemFields(itemData);
        updateItemStatus('existing', `Mã đã tồn tại: ${itemData.name}`);
        hideSuggestions('itemCodeSuggestions');
        return;
    }

    // Show suggestions
    const suggestions = Array.from(itemCodeCache.keys())
        .filter(code => code.includes(value))
        .slice(0, 5);

    if (suggestions.length > 0) {
        showItemCodeSuggestions(suggestions);
    } else {
        hideSuggestions('itemCodeSuggestions');
        clearItemFields();
        updateItemStatus('new', 'Mã hàng mới - sẽ được tạo');
    }
}

function clearItemFields() {
    document.getElementById('newItemName').value = '';
    document.getElementById('newItemCategory').value = '';
    document.getElementById('newItemLocation').value = '';
    document.getElementById('newItemUnit').value = '';
    updateUnitSelector('');
}

function showItemCodeSuggestions(suggestions) {
    const dropdown = document.getElementById('itemCodeSuggestions');

    dropdown.innerHTML = suggestions.map(code => {
        const item = itemCodeCache.get(code);
        return `
            <div class="suggestion-item" onclick="selectItemCode('${code}')">
                <strong>${code}</strong> - ${item.name}
                <br><small class="text-muted">${item.category} | ${item.unit}</small>
            </div>
        `;
    }).join('');

    dropdown.style.display = 'block';
}

window.selectItemCode = function (code) {
    document.getElementById('newItemCode').value = code;
    const itemData = itemCodeCache.get(code);
    fillItemFields(itemData);
    updateItemStatus('existing', `Mã đã tồn tại: ${itemData.name}`);
    hideSuggestions('itemCodeSuggestions');
    document.getElementById('newItemQuantity').focus();
};

function updateItemStatus(type, message) {
    const statusDiv = document.getElementById('itemStatus');
    if (!type) {
        statusDiv.innerHTML = '';
        return;
    }

    const iconMap = {
        'existing': 'fas fa-info-circle',
        'new': 'fas fa-plus-circle'
    };

    const classMap = {
        'existing': 'status-existing',
        'new': 'status-new'
    };

    statusDiv.innerHTML = `
        <div class="status-indicator ${classMap[type]}">
            <i class="${iconMap[type]}"></i>
            ${message}
        </div>
    `;
}

function fillItemFields(itemData) {
    document.getElementById('newItemName').value = itemData.name;
    document.getElementById('newItemCategory').value = itemData.category;
    document.getElementById('newItemLocation').value = itemData.location;

    // Select unit
    const unitSelect = document.getElementById('newItemUnit');
    unitSelect.value = itemData.unit;

    // Update unit selector
    updateUnitSelector(itemData.unit);
}

function selectUnit(unit) {
    document.getElementById('newItemUnit').value = unit;
    updateUnitSelector(unit);
}

// Update unit selector visual state
function updateUnitSelector(selectedUnit) {
    document.querySelectorAll('.unit-option').forEach(button => {
        button.classList.toggle('selected', button.textContent === selectedUnit);
    });
}

window.addImportItem = function () {
    // Lưu lại focus của nút "Thêm mặt hàng"
    const lastFocusedElement = document.activeElement;

    const itemModal = createItemModal();
    document.body.appendChild(itemModal);
    const bsModal = new bootstrap.Modal(itemModal);
    bsModal.show();

    // Lắng nghe sự kiện khi modal đã đóng
    itemModal.addEventListener('hidden.bs.modal', () => {
        // Trả focus về và dọn dẹp modal
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
        itemModal.remove();
    });
};


// Thay thế hàm này trong warehouse.js

function createItemModal(item = null) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'itemModal'; // Thêm ID để dễ dàng quản lý
    modal.setAttribute('tabindex', '-1');

    // Danh sách đơn vị tính đầy đủ
    const units = [
        'Cái', 'Chiếc', 'Bộ', 'Hộp', 'Thùng', 'Cuộn', 'Tấm', 'Túi', 'Gói',
        'Chai', 'Lọ', 'Lon', 'Bao', 'Kg', 'Gam', 'Tấn', 'Mét', 'Cây', 'Thanh', 'Đôi'
    ].sort(); // Sắp xếp theo alphabet

    modal.innerHTML = `
        <div class="modal-dialog modal-lg"> <!-- Tăng kích thước modal thành modal-lg -->
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">${item ? 'Sửa mặt hàng' : 'Thêm mặt hàng mới'}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="itemForm">
                        <div class="row">
                            <!-- CỘT BÊN TRÁI -->
                            <div class="col-md-6">
                                <div class="mb-3">
                                    <label for="itemCode" class="form-label">Mã hàng <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control" id="itemCode" value="${item?.code || ''}" required>
                                </div>
                                <div class="mb-3">
                                    <label for="itemName" class="form-label">Tên mô tả <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control" id="itemName" value="${item?.name || ''}" required>
                                </div>
                                <div class="mb-3">
                                    <label for="itemCategory" class="form-label">Danh mục <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control" id="itemCategory" value="${item?.category || ''}" required>
                                </div>
                            </div>

                            <!-- CỘT BÊN PHẢI -->
                            <div class="col-md-6">
                                <div class="mb-3">
                                    <label for="itemQuantity" class="form-label">Số lượng <span class="text-danger">*</span></label>
                                    <input type="number" class="form-control" id="itemQuantity" value="${item?.quantity || ''}" required min="0">
                                </div>
                                <div class="mb-3">
                                    <label for="itemUnit" class="form-label">Đơn vị tính <span class="text-danger">*</span></label>
                                    <select class="form-select" id="itemUnit" required>
                                        <option value="" disabled ${!item ? 'selected' : ''}>-- Chọn đơn vị --</option>
                                        ${units.map(unit =>
        `<option value="${unit}" ${item?.unit === unit ? 'selected' : ''}>${unit}</option>`
    ).join('')}
                                    </select>
                                </div>
                                <div class="mb-3">
                                    <label for="itemLocation" class="form-label">Vị trí <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control" id="itemLocation" value="${item?.location || ''}" required>
                                    <!-- Diễn giải vị trí -->
                                    <small id="locationHelp" class="form-text text-muted">
                                        Gợi ý đặt tên: <strong>A1-01</strong> (Dãy A, Ô số 1, Tầng 1)
                                    </small>
                                </div>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-primary" onclick="saveImportItem(${item ? item.index : -1})">
                        ${item ? 'Cập nhật' : 'Thêm vào phiếu'}
                    </button>
                </div>
            </div>
        </div>
    `;
    return modal;
}


// Thay thế hàm này trong warehouse.js

window.saveImportItem = function (index = -1) {
    // 1. Lấy dữ liệu từ form
    const code = document.getElementById('itemCode').value.trim();
    const name = document.getElementById('itemName').value.trim();
    const category = document.getElementById('itemCategory').value.trim();
    const quantity = document.getElementById('itemQuantity').value;
    const unit = document.getElementById('itemUnit').value;
    const location = document.getElementById('itemLocation').value.trim();

    // 2. Kiểm tra dữ liệu (Validation)
    if (!code || !name || !category || !quantity || !unit || !location) {
        showToast('Vui lòng điền đầy đủ các trường bắt buộc (*)', 'warning');
        return;
    }

    if (parseInt(quantity) < 0) {
        showToast('Số lượng không thể là số âm', 'warning');
        return;
    }

    // 3. Tạo đối tượng item
    const item = {
        code: code,
        name: name,
        unit: unit,
        quantity: parseInt(quantity),
        category: category,
        location: location
    };

    // 4. Thêm hoặc cập nhật vào danh sách
    if (index >= 0) {
        currentImportItems[index] = item;
    } else {
        currentImportItems.push(item);
    }

    // 5. Cập nhật lại bảng hàng hóa trong phiếu nhập
    updateImportItemsTable();

    // 6. Đóng modal thêm/sửa mặt hàng
    const itemModal = document.getElementById('itemModal');
    if (itemModal) {
        const bsModal = bootstrap.Modal.getInstance(itemModal);
        if (bsModal) {
            bsModal.hide();
        }
    }
};

function updateImportItemsTable() {
    const tbody = document.getElementById('importItemsTable');
    const emptyRow = document.getElementById('emptyTableRow');

    if (currentImportItems.length === 0) {
        emptyRow.style.display = '';
        // Remove existing item rows
        tbody.querySelectorAll('tr:not(#emptyTableRow)').forEach(row => row.remove());
    } else {
        emptyRow.style.display = 'none';

        // Clear existing rows
        tbody.querySelectorAll('tr:not(#emptyTableRow)').forEach(row => row.remove());

        // Add item rows
        currentImportItems.forEach((item, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${item.code}</strong></td>
                <td>${item.name}</td>
                <td class="text-center"><span class="badge bg-primary">${item.quantity}</span></td>
                <td class="text-center">${item.unit}</td>
                <td>${item.category}</td>
                <td><span class="badge bg-secondary">${item.location}</span></td>
                <td class="text-center">
                    <button class="btn btn-warning btn-sm me-1" onclick="editImportItem(${index})" title="Sửa">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="removeImportItem(${index})" title="Xóa">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(row);
        });
    }

    // Update item count badge
    document.getElementById('itemCountBadge').textContent = `${currentImportItems.length} mặt hàng`;
}

window.editImportItem = function (index) {
    const item = currentImportItems[index];

    // Fill form with item data
    document.getElementById('newItemCode').value = item.code;
    document.getElementById('newItemName').value = item.name;
    document.getElementById('newItemQuantity').value = item.quantity;
    document.getElementById('newItemUnit').value = item.unit;
    document.getElementById('newItemCategory').value = item.category;
    document.getElementById('newItemLocation').value = item.location;

    updateUnitSelector(item.unit);
    updateItemStatus('existing', `Đang chỉnh sửa: ${item.name}`);

    // Remove item from list temporarily
    currentImportItems.splice(index, 1);
    updateImportItemsTable();
    updateSaveButtonState();

    // Focus on quantity field
    document.getElementById('newItemQuantity').focus();
    document.getElementById('newItemQuantity').select();
};

window.removeImportItem = async function (index) {
    const item = currentImportItems[index];

    const confirmed = await showConfirmation(
        'Xóa mặt hàng',
        `Bạn có chắc muốn xóa "${item.name}" khỏi danh sách?`,
        'Xóa',
        'Hủy',
        'danger'
    );

    if (confirmed) {
        currentImportItems.splice(index, 1);
        updateImportItemsTable();
        updateSaveButtonState();
        showToast(`Đã xóa "${item.name}" khỏi danh sách`, 'success');
    }
};

window.saveImport = async function () {
    if (currentImportItems.length === 0) {
        showToast('Vui lòng thêm ít nhất một mặt hàng', 'warning');
        return;
    }

    const importNumber = document.getElementById('importNumber').value;
    const supplier = document.getElementById('supplier').value;

    if (!importNumber || !supplier) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);

        // Create import transaction
        const importDoc = doc(collection(db, 'transactions'));
        batch.set(importDoc, {
            type: 'import',
            importNumber: importNumber,
            supplier: supplier,
            items: currentImportItems,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        // Update inventory
        for (const item of currentImportItems) {
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', item.code)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (snapshot.empty) {
                const inventoryDoc = doc(collection(db, 'inventory'));
                batch.set(inventoryDoc, {
                    code: item.code,
                    name: item.name,
                    unit: item.unit,
                    quantity: item.quantity,
                    category: item.category,
                    location: item.location,
                    createdAt: serverTimestamp()
                });
            } else {
                const inventoryDoc = snapshot.docs[0];
                batch.update(inventoryDoc.ref, {
                    quantity: increment(item.quantity),
                    name: item.name,
                    unit: item.unit,
                    category: item.category,
                    location: item.location
                });
            }
        }

        await batch.commit();

        // Toast cho người thực hiện
        showToast('Nhập kho thành công!', 'success');

        bootstrap.Modal.getInstance(document.querySelector('.modal')).hide();
        loadImportHistory();

    } catch (error) {
        console.error('Error saving import:', error);
        showToast('Lỗi lưu phiếu nhập', 'danger');
    }
};

// Excel Import Functions
// Thay thế hàm downloadExcelTemplate() cũ
function downloadImportTemplate() {
    const data = [
        ['Mã hàng', 'Tên mô tả', 'Số lượng', 'Đơn vị tính', 'Danh mục', 'Vị trí'],
        ['SP-NEW-01', 'Sản phẩm mới hoàn toàn', '100', 'Cái', 'Hàng mới', 'C1-01'],
        ['SP-EXIST-01', 'Sản phẩm đã có trong kho', '50', 'Hộp', 'Hàng tiêu dùng', 'A1-05']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 20 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Nhap_Kho');
    XLSX.writeFile(wb, 'mau-nhap-kho.xlsx');
}

// Thay thế hàm handleExcelImport() cũ
function handleExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // Skip header row and process data, expecting 6 columns
            const items = data.slice(1).filter(row => row.length >= 6 && row[0]).map(row => ({
                code: row[0]?.toString().trim() || '',
                name: row[1]?.toString().trim() || '',
                quantity: parseInt(row[2]) || 0,
                unit: row[3]?.toString().trim() || '',
                category: row[4]?.toString().trim() || '',
                location: row[5]?.toString().trim() || ''
            }));

            if (items.length > 0) {
                // Thay vì showExcelImportModal, chúng ta gọi hàm mới có logic validation
                showImportExcelPreviewModal(items);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ hoặc thiếu cột', 'warning');
            }

        } catch (error) {
            console.error('Error reading Excel file:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = ''; // Reset file input
}

// Thêm 2 hàm mới này vào file warehouse.js

/**
 * Hiển thị modal xem trước cho việc nhập từ Excel, và bắt đầu quá trình kiểm tra dữ liệu.
 * @param {Array} items - Danh sách mặt hàng từ file Excel.
 */
function showImportExcelPreviewModal(items) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'importExcelPreviewModal'; // Đặt ID mới để tránh xung đột

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-success text-white">
                    <h5 class="modal-title">Xem trước & Xác nhận Nhập kho từ Excel</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="row mb-3">
                        <div class="col-md-6">
                            <label class="form-label">Số phiếu nhập <span class="text-danger">*</span></label>
                            <input type="text" class="form-control" id="excelImportNumber" required>
                        </div>
                        <div class="col-md-6">
                            <label class="form-label">Nhà cung cấp <span class="text-danger">*</span></label>
                            <input type="text" class="form-control" id="excelSupplier" required>
                        </div>
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelImportPreviewTable">
                            <thead class="table-success">
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>SL Nhập</th>
                                    <th>Đơn vị</th>
                                    <th>Danh mục</th>
                                    <th>Vị trí</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td colspan="7" class="text-center">
                                        <div class="spinner-border text-success" role="status">
                                            <span class="visually-hidden">Đang kiểm tra dữ liệu...</span>
                                        </div>
                                        <p class="mt-2">Đang kiểm tra dữ liệu...</p>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-success" onclick="saveExcelImport()" id="saveExcelImportBtn" disabled>
                        Xác nhận nhập kho
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Bắt đầu kiểm tra dữ liệu sau khi modal hiển thị
    validateAndDisplayImportItems(items);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

/**
 * Kiểm tra từng mặt hàng từ Excel, so sánh với DB và hiển thị kết quả lên table.
 * @param {Array} items - Danh sách mặt hàng từ file Excel.
 */
async function validateAndDisplayImportItems(items) {
    const tbody = document.querySelector('#excelImportPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelImportBtn');
    let allValid = true;
    const validatedItems = [];

    tbody.innerHTML = ''; // Xóa spinner

    for (const item of items) {
        const row = document.createElement('tr');
        let statusBadge = '';
        let itemIsValid = true;
        let status = ''; // 'new' or 'existing'

        // Validation cơ bản
        if (!item.code || !item.name || !item.unit || !item.category || !item.location) {
            statusBadge = `<span class="badge bg-danger">Lỗi - Thiếu thông tin</span>`;
            itemIsValid = false;
            row.classList.add('table-danger');
        } else if (item.quantity <= 0) {
            statusBadge = `<span class="badge bg-warning text-dark">Lỗi - SL không hợp lệ</span>`;
            itemIsValid = false;
            row.classList.add('table-warning');
        }

        if (itemIsValid) {
            try {
                const inventoryQuery = query(collection(db, 'inventory'), where('code', '==', item.code), limit(1));
                const snapshot = await getDocs(inventoryQuery);

                if (snapshot.empty) {
                    status = 'new';
                    statusBadge = `<span class="badge bg-primary">Mới</span>`;
                    row.classList.add('table-primary');
                } else {
                    status = 'existing';
                    statusBadge = `<span class="badge bg-info">Tồn tại</span>`;
                    row.classList.add('table-info');
                }
            } catch (error) {
                console.error("Error checking item:", item.code, error);
                statusBadge = `<span class="badge bg-danger">Lỗi kiểm tra</span>`;
                itemIsValid = false;
                row.classList.add('table-danger');
            }
        }
        
        row.innerHTML = `
            <td>${item.code}</td>
            <td>${item.name}</td>
            <td>${item.quantity}</td>
            <td>${item.unit}</td>
            <td>${item.category}</td>
            <td>${item.location}</td>
            <td>${statusBadge}</td>
        `;
        tbody.appendChild(row);

        if (!itemIsValid) {
            allValid = false;
        } else {
            validatedItems.push({ ...item, status: status });
        }
    }

    saveBtn.disabled = !allValid || validatedItems.length === 0;
    // Lưu danh sách đã được kiểm tra vào window để hàm save có thể sử dụng
    window.validatedImportItems = validatedItems; 
}


function showExcelImportModal(items) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Xác nhận nhập từ Excel</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="row mb-3">
                        <div class="col-md-6">
                            <label class="form-label">Số phiếu nhập</label>
                            <input type="text" class="form-control" id="excelImportNumber" required>
                        </div>
                        <div class="col-md-6">
                            <label class="form-label">Nhà cung cấp</label>
                            <input type="text" class="form-control" id="excelSupplier" required>
                        </div>
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered">
                            <thead>
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Đơn vị tính</th>
                                    <th>Số lượng</th>
                                    <th>Danh mục</th>
                                    <th>Vị trí</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${items.map(item => `
                                    <tr>
                                        <td>${item.code}</td>
                                        <td>${item.name}</td>
                                        <td>${item.unit}</td>
                                        <td>${item.quantity}</td>
                                        <td>${item.category}</td>
                                        <td>${item.location}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-primary" onclick="saveExcelImport(${JSON.stringify(items).replace(/"/g, '&quot;')})">
                        Xác nhận nhập kho
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

window.saveExcelImport = async function () {
    const importNumber = document.getElementById('excelImportNumber').value.trim();
    const supplier = document.getElementById('excelSupplier').value.trim();

    if (!importNumber || !supplier) {
        showToast('Vui lòng điền Số phiếu nhập và Nhà cung cấp', 'warning');
        return;
    }
    
    // Lấy dữ liệu đã được kiểm tra từ biến window
    const itemsToImport = window.validatedImportItems;
    if (!itemsToImport || itemsToImport.length === 0) {
        showToast('Không có mặt hàng hợp lệ để nhập kho', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);

        // Tạo transaction log
        const importDocRef = doc(collection(db, 'transactions'));
        batch.set(importDocRef, {
            type: 'import',
            importNumber: importNumber,
            supplier: supplier,
            items: itemsToImport, // Lưu danh sách đầy đủ
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp(),
            source: 'excel'
        });

        // Cập nhật hoặc tạo mới trong kho
        for (const item of itemsToImport) {
            if (item.status === 'new') {
                // Tạo mới sản phẩm trong kho
                const newInventoryDoc = doc(collection(db, 'inventory'));
                batch.set(newInventoryDoc, {
                    code: item.code,
                    name: item.name,
                    unit: item.unit,
                    quantity: item.quantity,
                    category: item.category,
                    location: item.location,
                    createdAt: serverTimestamp()
                });
            } else if (item.status === 'existing') {
                // Cập nhật sản phẩm đã có
                const q = query(collection(db, 'inventory'), where('code', '==', item.code), limit(1));
                const snapshot = await getDocs(q); // Phải query lại trong batch
                if (!snapshot.empty) {
                    const inventoryDocRef = snapshot.docs[0].ref;
                    batch.update(inventoryDocRef, {
                        quantity: increment(item.quantity),
                        name: item.name, // Cập nhật cả thông tin khác nếu cần
                        unit: item.unit,
                        category: item.category,
                        location: item.location
                    });
                }
            }
        }

        await batch.commit();

        showToast('Nhập kho từ Excel thành công!', 'success');
        
        const modal = document.getElementById('importExcelPreviewModal');
        if (modal) {
           bootstrap.Modal.getInstance(modal).hide();
        }
        
        loadImportHistory();

    } catch (error) {
        console.error('Error saving Excel import:', error);
        showToast('Lỗi lưu phiếu nhập từ Excel', 'danger');
    }
};

// Load import history
async function loadImportHistory(useFilter = false) {
    try {
        let constraints = [where('type', '==', 'import')];

        if (useFilter) {
            const fromDate = document.getElementById('importFromDate')?.value;
            const toDate = document.getElementById('importToDate')?.value;

            if (fromDate) {
                const startDate = new Date(fromDate);
                constraints.push(where('timestamp', '>=', startDate));
            }

            if (toDate) {
                const endDate = new Date(toDate);
                endDate.setHours(23, 59, 59, 999);
                constraints.push(where('timestamp', '<=', endDate));
            }
        }

        constraints.push(orderBy('timestamp', 'desc'));

        const importsQuery = query(collection(db, 'transactions'), ...constraints);
        let snapshot = await getDocs(importsQuery);

        // Client-side filtering for item code
        let docs = snapshot.docs;
        if (useFilter) {
            const itemCodeFilter = document.getElementById('importItemCodeFilter')?.value;
            if (itemCodeFilter) {
                docs = docs.filter(doc => {
                    const data = doc.data();
                    return data.items?.some(item =>
                        item.code?.toLowerCase().includes(itemCodeFilter.toLowerCase())
                    );
                });
            }
        }

        const content = document.getElementById('importContent');

        if (docs.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy phiếu nhập nào.</p>';
            return;
        }

        // Create pagination component
        createImportPagination(docs, content);

    } catch (error) {
        console.error('Error loading import history:', error);
        showToast('Lỗi tải lịch sử nhập kho', 'danger');
    }
}

function createImportPagination(allData, container) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        // Create table
        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Số phiếu</th>
                    <th>Nhà cung cấp</th>
                    <th>Số mặt hàng</th>
                    <th>Người thực hiện</th>
                    <th>Ngày nhập</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        pageData.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');

            const date = data.timestamp ?
                data.timestamp.toDate().toLocaleDateString('vi-VN') :
                'N/A';

            // Tạo nút thao tác dựa trên quyền
            let actionButtons = `
                <button class="btn btn-info btn-sm me-1" onclick="viewImportDetails('${doc.id}')">
                    <i class="fas fa-eye"></i> Xem
                </button>
            `;

            // Chỉ Super Admin mới thấy nút sửa/xóa
            if (userRole === 'super_admin') {
                actionButtons += `
                    <button class="btn btn-warning btn-sm me-1" onclick="editImportTransaction('${doc.id}')">
                        <i class="fas fa-edit"></i> Sửa
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteImportTransaction('${doc.id}')">
                        <i class="fas fa-trash"></i> Xóa
                    </button>
                `;
            }

            row.innerHTML = `
                <td>${data.importNumber}</td>
                <td>${data.supplier}</td>
                <td>${data.items?.length || 0}</td>
                <td>${data.performedByName}</td>
                <td>${date}</td>
                <td>${actionButtons}</td>
            `;

            tbody.appendChild(row);
        });

        // Create pagination
        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="Import pagination">
                <ul class="pagination pagination-sm mb-0" id="importPagination">
                </ul>
            </nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);

        updatePaginationControls(page, totalPages, 'importPagination', renderPage);
    }

    renderPage(1);
}

window.viewImportDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu nhập', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createImportDetailsModal(data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading import details:', error);
        showToast('Lỗi tải chi tiết phiếu nhập', 'danger');
    }
};

// Thay thế hàm này trong warehouse.js

function createImportDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const totalItems = data.items?.length || 0;
    const totalQuantity = data.items?.reduce((sum, item) => sum + (item.quantity || 0), 0) || 0;

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-success text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-download"></i> Chi tiết phiếu nhập kho
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- THÔNG BÁO THÀNH CÔNG -->
                    <div class="alert alert-success d-flex align-items-center mb-4">
                        <i class="fas fa-check-circle fa-2x me-3"></i>
                        <div>
                            <strong>Nhập kho thành công</strong><br>
                            <small>Đã nhập ${totalItems} mặt hàng với tổng số lượng ${totalQuantity} vào kho</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-12 mb-2">
                            <span class="badge bg-success">
                                <i class="fas fa-download"></i> Phiếu nhập kho
                            </span>
                            ${data.source === 'excel' ? '<span class="badge bg-info ms-2"><i class="fas fa-file-excel"></i> Từ Excel</span>' : ''}
                        </div>
                        <div class="col-md-6"><strong>Số phiếu:</strong> ${data.importNumber}</div>
                        <div class="col-md-6"><strong>Nhà cung cấp:</strong> ${data.supplier}</div>
                        <div class="col-md-6"><strong>Tổng số mặt hàng:</strong> ${totalItems}</div>
                        <div class="col-md-6"><strong>Người nhập kho:</strong> ${data.performedByName}</div>
                        <div class="col-md-6"><strong>Tổng số lượng:</strong> ${totalQuantity}</div>                       
                        <div class="col-md-6"><strong>Ngày nhập:</strong> ${date}</div>

                    </div>

                    
                    
                    <!-- DANH SÁCH HÀNG HÓA -->
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-list me-2"></i>Danh sách hàng hóa đã nhập
                    </h6>
                    <div class="table-responsive">
                        <table class="table table-bordered table-compact">
                            <thead class="table-success">
                                <tr>
                                    <th>STT</th>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Số lượng</th>
                                    <th>Đơn vị tính</th>
                                    <th>Danh mục</th>
                                    <th>Vị trí</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${data.items?.map((item, index) => `
                                    <tr>
                                        <td class="text-center">${index + 1}</td>
                                        <td><strong>${item.code}</strong></td>
                                        <td>${item.name}</td>
                                        <td class="text-center"><strong class="text-success">${item.quantity}</strong></td>
                                        <td class="text-center">${item.unit}</td>
                                        <td class="text-center">${item.category}</td>
                                        <td class="text-center"><span class="badge bg-secondary">${item.location}</span></td>
                                    </tr>
                                `).join('') || '<tr><td colspan="7" class="text-center">Không có dữ liệu</td></tr>'}
                            </tbody>
                        </table>
                    </div>

                    <!-- THÔNG TIN TÁC ĐỘNG -->
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> Tất cả hàng hóa đã được thêm vào tồn kho tại các vị trí được chỉ định. 
                        Nếu sản phẩm đã tồn tại, số lượng đã được cộng dồn.
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}



// Export Section Functions
export function loadExportSection() {
    loadExportHistory();
}

// Thay thế hàm này trong warehouse.js

function showExportModal() {
    // Reset danh sách hàng hóa mỗi khi mở modal
    currentExportItems = [];

    const modal = createExportModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    // Lắng nghe sự kiện khi modal được hiển thị xong
    modal.addEventListener('shown.bs.modal', () => {
        // Tự động focus vào ô nhập mã hàng
        document.getElementById('exportItemCodeInput').focus();
    });

    // Lắng nghe sự kiện khi modal đóng
    modal.addEventListener('hidden.bs.modal', () => {
        // Hàm createExportModal đã lưu focus, giờ chỉ cần dọn dẹp
        modal.remove();
    });

    bsModal.show();
}

function createExportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'exportModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-warning text-dark">
                    <h5 class="modal-title">
                        <i class="fas fa-upload"></i> Tạo phiếu xuất kho
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="exportForm" onsubmit="return false;">
                        <!-- THÔNG TIN PHIẾU -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-file-alt"></i>
                                Thông tin phiếu xuất
                            </div>
                            <div class="row">
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-hashtag text-warning"></i>
                                            Số phiếu xuất <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="exportNumber" required>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-user text-warning"></i>
                                            Người nhận <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="recipient" required>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- THÊM HÀNG HÓA XUẤT -->
                        <div class="form-section-compact form-section-collapsible" id="addExportItemSection">
                            <div class="form-section-header-compact">
                                <i class="fas fa-search"></i>
                                Thêm hàng hóa xuất kho
                                <button type="button" class="collapse-toggle" onclick="toggleExportItemSection()">
                                    <i class="fas fa-chevron-up" id="exportCollapseIcon"></i> Thu gọn
                                </button>
                            </div>
                            <div class="form-section-body">
                                <div class="quick-input-row">
                                    <div class="row align-items-end">
                                        <div class="col-md-2">
                                            <label class="form-label-compact">
                                                <i class="fas fa-barcode text-warning"></i> Mã hàng cần xuất *
                                            </label>
                                            <div class="autocomplete-container-compact">
                                                <input type="text" class="form-control-compact" id="exportItemCodeInput" 
                                                       placeholder="Nhập mã hàng..." autocomplete="off">
                                                <div class="suggestion-dropdown-compact" id="exportItemSuggestions" style="display: none;"></div>
                                                <input type="hidden" id="selectedExportInventoryId">
                                            </div>
                                        </div>
                                        <div class="col-md-2">
                                            <label class="form-label-compact">
                                                <i class="fas fa-tag text-warning"></i> Tên sản phẩm
                                            </label>
                                            <input type="text" class="form-control-compact" id="exportItemName" readonly>
                                        </div>
                                        <div class="col-md-2">
                                            <label class="form-label-compact">
                                                <i class="fas fa-warehouse text-warning"></i> Tồn kho
                                            </label>
                                            <input type="text" class="form-control-compact" id="exportCurrentStock" readonly>
                                        </div>
                                        <div class="col-md-2">
                                            <label class="form-label-compact">
                                                <i class="fas fa-sort-numeric-up text-warning"></i> SL xuất *
                                            </label>
                                            <input type="number" class="form-control-compact" id="exportQuantity" min="1" placeholder="0">
                                        </div>
                                        <div class="col-md-3">
                                            <button type="button" class="btn btn-warning btn-sm w-80" onclick="addExportItem()">
                                                <i class="fas fa-plus"></i> Thêm vào danh sách
                                            </button>
                                        </div>
                                    </div>
                                    <div class="row mt-2">
                                        <div class="col-12">
                                            <small class="text-muted">
                                                <i class="fas fa-lightbulb"></i> 
                                                Nhập mã hàng và chờ hệ thống tìm kiếm tồn kho
                                            </small>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- DANH SÁCH XUẤT KHO -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-list-check"></i>
                                Danh sách hàng hóa xuất kho
                                <span class="badge bg-warning text-dark ms-auto" id="exportItemCountBadge">0 mặt hàng</span>
                            </div>
                            <div class="table-responsive">
                                <table class="table table-bordered table-compact">
                                    <thead class="table-warning">
                                        <tr>
                                            <th style="width: 15%">Mã hàng</th>
                                            <th style="width: 35%">Tên mô tả</th>
                                            <th style="width: 12%">SL xuất</th>
                                            <th style="width: 12%">Đơn vị</th>
                                            <th style="width: 12%">Tồn còn</th>
                                            <th style="width: 14%">Thao tác</th>
                                        </tr>
                                    </thead>
                                    <tbody id="exportItemsTable">
                                        <tr id="emptyExportTableRow">
                                            <td colspan="6" class="text-center text-muted py-3">
                                                <i class="fas fa-box-open fa-lg mb-1"></i><br>
                                                <small>Chưa có hàng hóa nào để xuất</small>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-warning" onclick="saveExport()" id="saveExportBtn" disabled>
                        <i class="fas fa-save"></i> Lưu phiếu xuất
                    </button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        setupExportModalEventListeners();
        suggestExportNumber();
    }, 0);

    return modal;
}

function suggestExportNumber() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = today.toTimeString().slice(0, 5).replace(':', '');
    const suggested = `XK${dateStr}${timeStr}`;

    const exportNumberInput = document.getElementById('excelExportNumber');
    if (exportNumberInput) {
        exportNumberInput.placeholder = `Gợi ý: ${suggested}`;
    }
}


function createLocationCard(docId, data, targetPrefix) {
    const card = document.createElement('div');
    card.className = 'col-md-6 mb-3';

    card.innerHTML = `
        <div class="card h-100 location-card" data-doc-id="${docId}" data-target="${targetPrefix}">
            <div class="card-body text-center">
                <h6 class="card-title text-primary">
                    <i class="fas fa-map-marker-alt"></i> ${data.location}
                </h6>
                <p class="card-text">
                    <strong>${data.name}</strong><br>
                    <span class="badge bg-secondary">Tồn kho: ${data.quantity}</span>
                </p>
            </div>
        </div>
    `;

    // Add click event listener
    const cardElement = card.querySelector('.location-card');
    cardElement.addEventListener('click', () => {
        selectLocationForAdjust(docId, targetPrefix, data);
    });

    return card;
}

window.selectLocationForAdjust = function (docId, targetPrefix, data) {
    try {
        document.querySelectorAll('.location-card').forEach(card => {
            card.classList.remove('selected');
        });

        const clickedCard = document.querySelector(`[data-doc-id="${docId}"][data-target="${targetPrefix}"]`);
        if (clickedCard) {
            clickedCard.classList.add('selected');
        }

        if (targetPrefix === 'request') {
            fillRequestDetails(docId, data);
        } else if (targetPrefix === 'adjust') {
            fillAdjustDetails(docId, data);
        } else if (targetPrefix === 'directAdjust') {
            fillDirectAdjustDetails(docId, data);
        }
    } catch (error) {
        console.error('Error selecting location:', error);
        showToast('Lỗi khi chọn vị trí', 'danger');
    }
};

function fillDirectAdjustDetails(docId, data) {
    const detailsContainer = safeGetElement('directAdjustDetailsSection', 'direct adjust form');
    const confirmBtn = safeGetElement('confirmDirectAdjustBtn', 'direct adjust form');

    const productInfo = safeGetElement('directAdjustProductInfo', 'direct adjust form');
    const locationInfo = safeGetElement('directAdjustLocationInfo', 'direct adjust form');
    const currentQty = safeGetElement('directAdjustCurrentQty', 'direct adjust form');
    const newQuantityInput = safeGetElement('directAdjustNewQuantity', 'direct adjust form');
    const inventoryIdInput = safeGetElement('directAdjustInventoryId', 'direct adjust form');

    if (productInfo) productInfo.textContent = data.name;
    if (locationInfo) locationInfo.textContent = data.location;
    if (currentQty) currentQty.textContent = data.quantity;
    if (newQuantityInput) {
        newQuantityInput.value = data.quantity;
        newQuantityInput.focus();
        newQuantityInput.select();
    }
    if (inventoryIdInput) inventoryIdInput.value = docId;

    if (detailsContainer) detailsContainer.style.display = 'block';
    if (confirmBtn) confirmBtn.disabled = false;

    updateWorkflowStep('directAdjustStep', true);
    updateDirectAdjustmentCalculation();
}

window.saveDirectAdjust = async function () {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền chỉnh số trực tiếp', 'danger');
        return;
    }

    try {
        const inventoryIdInput = safeGetElement('directAdjustInventoryId', 'save direct adjust');
        const currentQuantityElement = safeGetElement('directAdjustCurrentQty', 'save direct adjust');
        const newQuantityInput = safeGetElement('directAdjustNewQuantity', 'save direct adjust');
        const reasonInput = safeGetElement('directAdjustReason', 'save direct adjust');

        if (!inventoryIdInput || !currentQuantityElement || !newQuantityInput || !reasonInput) {
            showToast('Không thể lấy dữ liệu từ form. Vui lòng thử lại.', 'danger');
            return;
        }

        const inventoryId = inventoryIdInput.value;
        const currentQuantity = parseInt(currentQuantityElement.textContent) || 0;
        const newQuantityStr = newQuantityInput.value;
        const reason = reasonInput.value.trim();

        // Validation
        if (!inventoryId) {
            showToast('Vui lòng chọn một vị trí để điều chỉnh.', 'warning');
            return;
        }

        if (newQuantityStr === '' || isNaN(parseInt(newQuantityStr))) {
            showToast('Vui lòng nhập số lượng mới hợp lệ.', 'warning');
            newQuantityInput.focus();
            return;
        }

        const newQuantity = parseInt(newQuantityStr);
        if (newQuantity < 0) {
            showToast('Số lượng mới không được âm.', 'warning');
            newQuantityInput.focus();
            return;
        }

        if (!reason) {
            showToast('Vui lòng nhập lý do điều chỉnh.', 'warning');
            reasonInput.focus();
            return;
        }

        if (newQuantity === currentQuantity) {
            showToast('Số lượng mới giống số lượng hiện tại, không có gì để điều chỉnh.', 'info');
            return;
        }

        // Confirmation
        const confirmed = await showConfirmation(
            'Xác nhận chỉnh số trực tiếp',
            `Bạn có chắc muốn điều chỉnh tồn kho từ ${currentQuantity} thành ${newQuantity}?<br><br><strong>Chênh lệch:</strong> ${newQuantity > currentQuantity ? '+' : ''}${newQuantity - currentQuantity}<br><br><em>Thao tác này sẽ thực hiện ngay lập tức.</em>`,
            'Thực hiện chỉnh số',
            'Hủy',
            'danger'
        );

        if (!confirmed) return;

        // Get inventory data
        const inventoryRef = doc(db, 'inventory', inventoryId);
        const inventorySnap = await getDoc(inventoryRef);

        if (!inventorySnap.exists()) {
            showToast('Không tìm thấy thông tin tồn kho.', 'danger');
            return;
        }

        const inventoryData = inventorySnap.data();

        const batch = writeBatch(db);

        // Update inventory quantity
        batch.update(inventoryRef, { quantity: newQuantity });

        // Log the direct adjustment transaction
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'adjust',
            subtype: 'direct', // Đánh dấu là chỉnh số trực tiếp
            inventoryId: inventoryId,
            itemCode: inventoryData.code,
            itemName: inventoryData.name,
            location: inventoryData.location,
            previousQuantity: currentQuantity,
            newQuantity: newQuantity,
            adjustment: newQuantity - currentQuantity,
            reason: reason,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Chỉnh số trực tiếp thành công!', 'success');

        const modal = document.getElementById('directAdjustModal');
        if (modal) {
            const bsModal = bootstrap.Modal.getInstance(modal);
            if (bsModal) {
                bsModal.hide();
            }
        }

        loadDirectAdjustHistory();

    } catch (error) {
        console.error('Error saving direct adjustment:', error);
        showToast('Lỗi nghiêm trọng khi chỉnh số trực tiếp.', 'danger');
    }
};

async function loadDirectAdjustHistory(useFilter = false) {
    try {
        let constraints = [where('type', '==', 'adjust')];

        if (useFilter) {
            const fromDate = document.getElementById('adjustFromDate')?.value;
            const toDate = document.getElementById('adjustToDate')?.value;

            if (fromDate) {
                const startDate = new Date(fromDate);
                constraints.push(where('timestamp', '>=', startDate));
            }

            if (toDate) {
                const endDate = new Date(toDate);
                endDate.setHours(23, 59, 59, 999);
                constraints.push(where('timestamp', '<=', endDate));
            }
        }

        constraints.push(orderBy('timestamp', 'desc'));

        const adjustsQuery = query(collection(db, 'transactions'), ...constraints);
        let snapshot = await getDocs(adjustsQuery);

        let docs = snapshot.docs;
        if (useFilter) {
            const itemCodeFilter = document.getElementById('adjustItemCodeFilter')?.value;
            if (itemCodeFilter) {
                docs = docs.filter(doc => {
                    const data = doc.data();
                    return data.itemCode?.toLowerCase().includes(itemCodeFilter.toLowerCase());
                });
            }
        }

        const content = document.getElementById('adjustContent');

        if (docs.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy phiếu chỉnh số nào.</p>';
            return;
        }

        createDirectAdjustPagination(docs, content);

    } catch (error) {
        console.error('Error loading direct adjust history:', error);
        showToast('Lỗi tải lịch sử chỉnh số', 'danger');
    }
}

function createDirectAdjustPagination(allData, container) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Mã hàng</th>
                    <th>Số lượng cũ</th>
                    <th>Số lượng mới</th>
                    <th>Chênh lệch</th>
                    <th>Nguồn gốc</th>
                    <th>Người thực hiện</th>
                    <th>Ngày chỉnh</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        pageData.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');

            const date = data.timestamp ?
                data.timestamp.toDate().toLocaleDateString('vi-VN') :
                'N/A';

            const adjustment = data.adjustment || 0;
            const adjustmentClass = adjustment > 0 ? 'text-success' : adjustment < 0 ? 'text-danger' : '';
            const adjustmentSymbol = adjustment > 0 ? '+' : '';

            let sourceInfo = '';
            if (data.requestId) {
                sourceInfo = `
                    <span class="badge bg-info">
                        <i class="fas fa-clipboard-check"></i> Từ yêu cầu
                    </span>
                `;
            } else if (data.subtype === 'direct') {
                sourceInfo = `
                    <span class="badge bg-danger">
                        <i class="fas fa-cogs"></i> Trực tiếp
                    </span>
                `;
            } else {
                sourceInfo = `
                    <span class="badge bg-secondary">
                        <i class="fas fa-edit"></i> Cũ
                    </span>
                `;
            }

            // Tạo nút thao tác cho Super Admin
            let actionButtons = `
                <button class="btn btn-info btn-sm me-1" onclick="viewAdjustDetails('${doc.id}')">
                    <i class="fas fa-eye"></i> Xem
                </button>
            `;

            // Chỉ Super Admin mới thấy nút sửa/xóa
            if (userRole === 'super_admin') {
                actionButtons += `
                    <button class="btn btn-warning btn-sm me-1" onclick="editAdjustTransaction('${doc.id}')">
                        <i class="fas fa-edit"></i> Sửa
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteAdjustTransaction('${doc.id}')">
                        <i class="fas fa-trash"></i> Xóa
                    </button>
                `;
            }

            row.innerHTML = `
                <td>${data.itemCode}</td>
                <td>${data.previousQuantity}</td>
                <td>${data.newQuantity}</td>
                <td class="${adjustmentClass}">${adjustmentSymbol}${adjustment}</td>
                <td>${sourceInfo}</td>
                <td>${data.performedByName}</td>
                <td>${date}</td>
                <td>${actionButtons}</td>
            `;

            tbody.appendChild(row);
        });

        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="Direct adjust pagination">
                <ul class="pagination pagination-sm mb-0" id="directAdjustPagination">
                </ul>
            </nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);

        updatePaginationControls(page, totalPages, 'directAdjustPagination', renderPage);
    }

    renderPage(1);
}

// === EDIT ADJUST TRANSACTION ===
window.editAdjustTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu chỉnh số', 'danger');
            return;
        }

        const data = docSnap.data();

        // Không cho sửa chỉnh số từ yêu cầu (đã được duyệt)
        if (data.requestId) {
            showToast('Không thể sửa chỉnh số từ yêu cầu đã duyệt', 'warning');
            return;
        }

        const modal = createEditAdjustModal(transactionId, data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading adjust for edit:', error);
        showToast('Lỗi tải thông tin phiếu chỉnh số', 'danger');
    }
};

function createEditAdjustModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editAdjustModal';

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-warning">
                    <h5 class="modal-title text-dark">
                        <i class="fas fa-edit"></i> Sửa phiếu chỉnh số tồn kho
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Cảnh báo:</strong> Việc sửa phiếu chỉnh số sẽ ảnh hưởng đến tồn kho hiện tại. Hãy cẩn thận!
                    </div>
                    
                    <form id="editAdjustForm">
                        <!-- THÔNG TIN SẢN PHẨM -->
                        <div class="row mb-3 p-3 bg-light rounded">
                            <div class="col-md-6">
                                <strong>Mã hàng:</strong> ${data.itemCode}
                            </div>
                            <div class="col-md-6">
                                <strong>Tên mô tả:</strong> ${data.itemName}
                            </div>
                            <div class="col-md-6">
                                <strong>Vị trí:</strong> ${data.location}
                            </div>
                            <div class="col-md-6">
                                <strong>Người thực hiện gốc:</strong> ${data.performedByName}
                            </div>
                        </div>

                        <!-- THÔNG TIN CHỈNH SỐ -->
                        <div class="row mb-3">
                            <div class="col-md-4">
                                <label class="form-label">Số lượng trước (không đổi)</label>
                                <input type="number" class="form-control" value="${data.previousQuantity}" readonly>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label">Số lượng mới <span class="text-danger">*</span></label>
                                <input type="number" class="form-control" id="editAdjustNewQuantity" 
                                       value="${data.newQuantity}" min="0" required>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label">Chênh lệch mới</label>
                                <input type="text" class="form-control" id="editAdjustDifference" readonly>
                            </div>
                        </div>

                        <div class="mb-3">
                            <label class="form-label">Lý do điều chỉnh <span class="text-danger">*</span></label>
                            <input type="text" class="form-control" id="editAdjustReason" 
                                   value="${data.reason}" required>
                        </div>
                        
                        <input type="hidden" id="editAdjustTransactionId" value="${transactionId}">
                        <input type="hidden" id="editAdjustInventoryId" value="${data.inventoryId}">
                        <input type="hidden" id="editAdjustPreviousQuantity" value="${data.previousQuantity}">
                        <input type="hidden" id="editAdjustOriginalNewQuantity" value="${data.newQuantity}">
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-warning" onclick="saveEditAdjust()">
                        <i class="fas fa-save"></i> Lưu thay đổi
                    </button>
                </div>
            </div>
        </div>
    `;

    // Setup real-time calculation
    setTimeout(() => {
        const newQuantityInput = document.getElementById('editAdjustNewQuantity');
        const differenceInput = document.getElementById('editAdjustDifference');
        const previousQuantity = parseInt(document.getElementById('editAdjustPreviousQuantity').value);

        function updateDifference() {
            const newQuantity = parseInt(newQuantityInput.value) || 0;
            const difference = newQuantity - previousQuantity;
            differenceInput.value = difference >= 0 ? `+${difference}` : difference;

            // Change color based on difference
            if (difference > 0) {
                differenceInput.className = 'form-control text-success fw-bold';
            } else if (difference < 0) {
                differenceInput.className = 'form-control text-danger fw-bold';
            } else {
                differenceInput.className = 'form-control text-muted';
            }
        }

        newQuantityInput.addEventListener('input', updateDifference);
        updateDifference(); // Initial calculation
    }, 0);

    return modal;
}

window.saveEditAdjust = async function () {
    const transactionId = document.getElementById('editAdjustTransactionId').value;
    const inventoryId = document.getElementById('editAdjustInventoryId').value;
    const previousQuantity = parseInt(document.getElementById('editAdjustPreviousQuantity').value);
    const originalNewQuantity = parseInt(document.getElementById('editAdjustOriginalNewQuantity').value);
    const newQuantity = parseInt(document.getElementById('editAdjustNewQuantity').value);
    const reason = document.getElementById('editAdjustReason').value.trim();

    if (!reason) {
        showToast('Vui lòng nhập lý do điều chỉnh', 'warning');
        return;
    }

    if (newQuantity < 0) {
        showToast('Số lượng mới không được âm', 'warning');
        return;
    }

    if (newQuantity === originalNewQuantity && reason === document.getElementById('editAdjustReason').defaultValue) {
        showToast('Không có thay đổi nào để lưu', 'info');
        return;
    }

    const confirmed = await showConfirmation(
        'Xác nhận cập nhật chỉnh số',
        `Bạn có chắc muốn cập nhật phiếu chỉnh số?<br><br><strong>Thay đổi:</strong><br>• Số lượng: ${originalNewQuantity} → ${newQuantity}<br>• Chênh lệch mới: ${newQuantity > previousQuantity ? '+' : ''}${newQuantity - previousQuantity}`,
        'Lưu thay đổi',
        'Hủy',
        'warning'
    );

    if (!confirmed) return;

    try {
        const batch = writeBatch(db);

        // Update transaction
        batch.update(doc(db, 'transactions', transactionId), {
            newQuantity: newQuantity,
            adjustment: newQuantity - previousQuantity,
            reason: reason,
            lastModified: serverTimestamp(),
            modifiedBy: currentUser.uid,
            modifiedByName: currentUser.name
        });

        // Calculate inventory adjustment
        const inventoryAdjustment = newQuantity - originalNewQuantity;

        // Update inventory if there's a change
        if (inventoryAdjustment !== 0) {
            batch.update(doc(db, 'inventory', inventoryId), {
                quantity: increment(inventoryAdjustment)
            });
        }

        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'adjust_edited',
            originalTransactionId: transactionId,
            itemCode: originalData.itemCode,
            changes: {
                newQuantity: { from: originalNewQuantity, to: newQuantity },
                reason: { from: originalData.reason, to: reason }
            },
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã cập nhật phiếu chỉnh số thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editAdjustModal')).hide();
        loadDirectAdjustHistory();

    } catch (error) {
        console.error('Error updating adjust:', error);
        showToast('Lỗi cập nhật phiếu chỉnh số', 'danger');
    }
};

// === DELETE ADJUST TRANSACTION ===
window.deleteAdjustTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu chỉnh số', 'danger');
            return;
        }

        const data = docSnap.data();

        // Không cho xóa chỉnh số từ yêu cầu (đã được duyệt)
        if (data.requestId) {
            showToast('Không thể xóa chỉnh số từ yêu cầu đã duyệt', 'warning');
            return;
        }

        const confirmed = await showConfirmation(
            'Xóa phiếu chỉnh số tồn kho',
            `Bạn có chắc muốn XÓA phiếu chỉnh số này?<br><br><strong>⚠️ Cảnh báo:</strong><br>• Thao tác này không thể hoàn tác<br>• Sẽ hoàn nguyên tồn kho về số lượng trước khi chỉnh<br><br><strong>Chi tiết:</strong><br>• Mã hàng: ${data.itemCode}<br>• Từ ${data.previousQuantity} → ${data.newQuantity}<br>• Sẽ khôi phục về: ${data.previousQuantity}`,
            'Xóa phiếu chỉnh số',
            'Hủy',
            'danger'
        );

        if (!confirmed) return;

        const batch = writeBatch(db);

        // Delete transaction
        batch.delete(doc(db, 'transactions', transactionId));

        // Revert inventory to previous quantity
        const inventoryRevert = data.previousQuantity - data.newQuantity;
        batch.update(doc(db, 'inventory', data.inventoryId), {
            quantity: increment(inventoryRevert)
        });

        // Log deletion
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'adjust_deleted',
            originalTransactionId: transactionId,
            deletedItemCode: data.itemCode,
            deletedPreviousQuantity: data.previousQuantity,
            deletedNewQuantity: data.newQuantity,
            deletedAdjustment: data.adjustment,
            deletedReason: data.reason,
            revertedTo: data.previousQuantity,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã xóa phiếu chỉnh số và khôi phục tồn kho thành công!', 'success');
        loadDirectAdjustHistory();

    } catch (error) {
        console.error('Error deleting adjust:', error);
        showToast('Lỗi xóa phiếu chỉnh số', 'danger');
    }
};

function fillAdjustDetails(docId, data) {
    const detailsContainer = safeGetElement('adjustDetailsSection', 'adjust form');
    const confirmBtn = safeGetElement('confirmAdjustBtn', 'adjust form');

    // Safely update elements
    const productInfo = safeGetElement('adjustProductInfo', 'adjust form');
    const locationInfo = safeGetElement('adjustLocationInfo', 'adjust form');
    const currentQty = safeGetElement('adjustCurrentQty', 'adjust form');
    const newQuantityInput = safeGetElement('adjustNewQuantity', 'adjust form');
    const inventoryIdInput = safeGetElement('adjustInventoryId', 'adjust form');

    if (productInfo) productInfo.textContent = data.name;
    if (locationInfo) locationInfo.textContent = data.location;
    if (currentQty) currentQty.textContent = data.quantity;
    if (newQuantityInput) {
        newQuantityInput.value = data.quantity;
        newQuantityInput.focus();
        newQuantityInput.select();
    }
    if (inventoryIdInput) inventoryIdInput.value = docId;

    if (detailsContainer) detailsContainer.style.display = 'block';
    if (confirmBtn) confirmBtn.disabled = false;

    // Update workflow
    updateWorkflowStep('adjustStep', true);

    // Trigger calculation update
    updateAdjustmentCalculation();
}

function setupExportModalEventListeners() {
    const itemCodeInput = document.getElementById('exportItemCodeInput');

    if (itemCodeInput) {
        itemCodeInput.addEventListener('input', debounce(handleExportItemCodeInput, 500));
        itemCodeInput.addEventListener('blur', () => {
            setTimeout(() => hideSuggestions('exportItemSuggestions'), 200);
        });
    }

    // Event listeners for form validation
    document.getElementById('exportNumber')?.addEventListener('input', updateExportSaveButtonState);
    document.getElementById('recipient')?.addEventListener('input', updateExportSaveButtonState);
}

function updateExportSaveButtonState() {
    const saveBtn = document.getElementById('saveExportBtn');
    const hasBasicInfo = document.getElementById('exportNumber').value.trim() &&
        document.getElementById('recipient').value.trim();
    const hasItems = currentExportItems.length > 0;

    saveBtn.disabled = !(hasBasicInfo && hasItems);
}

function updateTransferSaveButtonState() {
    const saveBtn = document.getElementById('saveTransferBtn');
    const hasAllInfo = document.getElementById('sourceInventoryId').value &&
        document.getElementById('transferQuantity').value &&
        document.getElementById('transferNewLocation').value.trim();

    saveBtn.disabled = !hasAllInfo;
}

async function handleExportItemCodeInput(event) {
    const code = event.target.value.trim().toUpperCase();
    event.target.value = code;

    const nameInput = document.getElementById('exportItemName');
    const stockInput = document.getElementById('exportCurrentStock');
    const quantityInput = document.getElementById('exportQuantity');
    const hiddenIdInput = document.getElementById('selectedExportInventoryId');

    // Reset fields
    nameInput.value = '';
    stockInput.value = '';
    quantityInput.value = '';
    quantityInput.max = '';
    hiddenIdInput.value = '';

    if (!code) return;

    try {
        const inventoryQuery = query(
            collection(db, 'inventory'),
            where('code', '==', code),
            limit(1)
        );
        const snapshot = await getDocs(inventoryQuery);

        if (snapshot.empty) {
            nameInput.value = 'Không tìm thấy';
            stockInput.value = '';
        } else {
            const doc = snapshot.docs[0];
            const data = doc.data();

            nameInput.value = data.name;
            stockInput.value = data.quantity;
            hiddenIdInput.value = doc.id;
            nameInput.dataset.unit = data.unit || '';

            // THÊM DÒNG NÀY: Lưu available quantity vào dataset
            stockInput.dataset.availableQuantity = data.quantity;

            if (data.quantity > 0) {
                quantityInput.max = data.quantity;
                quantityInput.focus();
                document.getElementById('addExportItemSection').style.display = 'block';
            } else {
                quantityInput.max = 0;
                showToast('Hàng đã hết tồn kho', 'warning');
            }
        }
    } catch (error) {
        console.error("Error fetching item for export:", error);
        nameInput.value = 'Lỗi truy vấn';
        showToast('Lỗi khi tìm kiếm mã hàng', 'danger');
    }
}



async function handleItemCodeInput(event) {
    const code = event.target.value.trim();
    const nameInput = document.getElementById('exportItemName');
    const stockInput = document.getElementById('currentStock');
    const quantityInput = document.getElementById('exportQuantity');
    const hiddenIdInput = document.getElementById('selectedInventoryId');

    // Reset các ô input
    nameInput.value = '';
    stockInput.value = '';
    quantityInput.value = '';
    quantityInput.max = '';
    hiddenIdInput.value = '';

    if (!code) {
        return; // Không làm gì nếu input rỗng
    }

    try {
        // Query database để tìm sản phẩm có mã hàng tương ứng
        const inventoryQuery = query(
            collection(db, 'inventory'),
            where('code', '==', code),
            limit(1)
        );
        const snapshot = await getDocs(inventoryQuery);

        if (snapshot.empty) {
            // Không tìm thấy sản phẩm
            nameInput.value = 'Không tìm thấy';
            stockInput.value = '';
        } else {
            // Tìm thấy sản phẩm
            const doc = snapshot.docs[0];
            const data = doc.data();

            nameInput.value = data.name;
            stockInput.value = data.quantity;
            hiddenIdInput.value = doc.id; // Lưu ID vào input ẩn
            nameInput.dataset.unit = data.unit || '';

            if (data.quantity > 0) {
                quantityInput.max = data.quantity;
                quantityInput.focus(); // Tự động focus vào ô số lượng
            } else {
                // Hàng đã hết, không cho nhập số lượng
                quantityInput.max = 0;
            }
        }
    } catch (error) {
        console.error("Error fetching item by code:", error);
        nameInput.value = 'Lỗi truy vấn';
        showToast('Lỗi khi tìm kiếm mã hàng', 'danger');
    }
}

async function loadInventoryForExport() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'), orderBy('name'));
        const snapshot = await getDocs(inventoryQuery);

        const select = document.getElementById('inventorySelect');
        select.innerHTML = '<option value="">-- Chọn mặt hàng --</option>';

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.quantity > 0) {
                const option = document.createElement('option');
                option.value = doc.id;
                option.textContent = `${data.code} - ${data.name} (Tồn: ${data.quantity})`;
                option.dataset.quantity = data.quantity;
                option.dataset.code = data.code;
                option.dataset.name = data.name;
                select.appendChild(option);
            }
        });

        // Handle selection change
        select.addEventListener('change', function () {
            const selectedOption = this.options[this.selectedIndex];
            if (selectedOption.value) {
                document.getElementById('currentStock').value = selectedOption.dataset.quantity;
                document.getElementById('exportQuantity').max = selectedOption.dataset.quantity;
            } else {
                document.getElementById('currentStock').value = '';
                document.getElementById('exportQuantity').max = '';
            }
        });

    } catch (error) {
        console.error('Error loading inventory:', error);
        showToast('Lỗi tải danh sách tồn kho', 'danger');
    }
}

window.addExportItem = function () {
    try {
        // Safe element retrieval
        const inventoryIdInput = safeGetElement('selectedExportInventoryId', 'add export item');
        const codeInput = safeGetElement('exportItemCodeInput', 'add export item');
        const nameInput = safeGetElement('exportItemName', 'add export item');
        const quantityInput = safeGetElement('exportQuantity', 'add export item');
        const availableQuantityInput = safeGetElement('exportCurrentStock', 'add export item');

        if (!inventoryIdInput || !codeInput || !nameInput || !quantityInput || !availableQuantityInput) {
            showToast('Không thể lấy dữ liệu từ form. Vui lòng thử lại.', 'danger');
            return;
        }

        const inventoryId = inventoryIdInput.value;
        const code = codeInput.value.trim();
        const name = nameInput.value;
        const unit = nameInput.dataset.unit || '';
        const quantity = parseInt(quantityInput.value);
        const availableQuantity = parseInt(availableQuantityInput.value);

        // Validation
        if (!inventoryId) {
            showToast('Mã hàng không hợp lệ hoặc không tồn tại.', 'warning');
            codeInput.focus();
            return;
        }

        if (isNaN(quantity) || quantity <= 0) {
            showToast('Vui lòng nhập số lượng xuất hợp lệ.', 'warning');
            quantityInput.focus();
            return;
        }

        if (availableQuantity === 0) {
            showToast('Sản phẩm này đã hết hàng.', 'warning');
            return;
        }

        if (quantity > availableQuantity) {
            showToast('Số lượng xuất vượt quá tồn kho hiện tại.', 'warning');
            quantityInput.focus();
            return;
        }

        // Check if item already in export list
        const existingIndex = currentExportItems.findIndex(item => item.inventoryId === inventoryId);

        if (existingIndex >= 0) {
            const totalQuantity = currentExportItems[existingIndex].quantity + quantity;
            if (totalQuantity > availableQuantity) {
                showToast('Tổng số lượng xuất vượt quá tồn kho.', 'warning');
                return;
            }
            currentExportItems[existingIndex].quantity = totalQuantity;
        } else {
            currentExportItems.push({
                inventoryId: inventoryId,
                code: code,
                name: name,
                quantity: quantity,
                unit: unit,
                availableQuantity: availableQuantity  // THÊM DÒNG NÀY
            });
        }

        // Update UI
        updateExportItemsTable();
        resetExportItemForm();
        updateExportSaveButtonState();

        // Auto-collapse section
        const section = document.getElementById('addExportItemSection');
        if (section && !section.classList.contains('collapsed')) {
            setTimeout(() => {
                const toggleFunction = window.toggleExportItemSection;
                if (toggleFunction) toggleFunction();
            }, 500);
        }

        showToast(`Đã thêm "${name}" vào danh sách xuất`, 'success');

    } catch (error) {
        console.error('Error adding export item:', error);
        showToast('Lỗi khi thêm mặt hàng xuất kho.', 'danger');
    }
};

// Reset export item form safely
function resetExportItemForm() {
    const fields = [
        'exportItemCodeInput',
        'selectedExportInventoryId',
        'exportItemName',
        'exportCurrentStock',
        'exportQuantity'
    ];

    fields.forEach(fieldId => {
        const field = safeGetElement(fieldId, 'reset export form');
        if (field) {
            field.value = '';
            if (field.dataset) {
                field.dataset.unit = '';
            }
        }
    });

    const codeInput = safeGetElement('exportItemCodeInput', 'reset export form');
    if (codeInput) {
        codeInput.focus();
    }
}

function updateExportItemsTable() {
    const tbody = safeGetElement('exportItemsTable', 'update export table');
    const emptyRow = safeGetElement('emptyExportTableRow', 'update export table');
    const countBadge = safeGetElement('exportItemCountBadge', 'update export table');

    if (!tbody) return;

    if (currentExportItems.length === 0) {
        if (emptyRow) emptyRow.style.display = '';
        // Remove existing item rows
        tbody.querySelectorAll('tr:not(#emptyExportTableRow)').forEach(row => row.remove());
    } else {
        if (emptyRow) emptyRow.style.display = 'none';

        // Clear existing rows
        tbody.querySelectorAll('tr:not(#emptyExportTableRow)').forEach(row => row.remove());

        // Add item rows
        currentExportItems.forEach((item, index) => {
            const row = document.createElement('tr');

            // Tính tồn còn sau khi xuất
            const remainingQuantity = (item.availableQuantity || 0) - item.quantity;

            row.innerHTML = `
                <td><strong>${item.code}</strong></td>
                <td>${item.name}</td>
                <td class="text-center"><span class="badge bg-warning text-dark">${item.quantity}</span></td>
                <td class="text-center">${item.unit || ''}</td>
                <td class="text-center">
                    <span class="badge ${remainingQuantity >= 0 ? 'bg-success' : 'bg-danger'}">
                        ${remainingQuantity}
                    </span>
                </td>
                <td class="text-center">
                    <button class="btn btn-danger btn-sm" onclick="removeExportItem(${index})" title="Xóa">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(row);
        });
    }

    // Update count badge
    if (countBadge) {
        countBadge.textContent = `${currentExportItems.length} mặt hàng`;
    }
}


export function loadRequestAdjustSection() {
    loadAdjustRequests();
    initializeAdjustRequestFilters();
}

function initializeAdjustRequestFilters() {
    document.getElementById('addAdjustRequestBtn')?.addEventListener('click', showAdjustRequestModal);
    
    // Gán sự kiện tìm kiếm trực tiếp cho các bộ lọc
    const filterInputs = ['requestFromDate', 'requestToDate', 'requestStatusFilter'];
    filterInputs.forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => loadAdjustRequests(true));
    });
}

function showAdjustRequestModal() {
    const lastFocusedElement = document.activeElement;
    const modal = createModalSafely(createAdjustRequestModal, 'adjustRequestModal');

    if (!modal) return;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        const firstInput = safeGetElement('requestItemCodeInput', 'adjust request modal');
        if (firstInput) firstInput.focus();
    });

    modal.addEventListener('hidden.bs.modal', () => {
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
        modal.remove();
    });

    bsModal.show();
}

function createAdjustRequestModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'adjustRequestModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-paper-plane"></i> Tạo yêu cầu chỉnh số tồn kho
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="adjustRequestForm" onsubmit="return false;">
                        <!-- WORKFLOW INDICATOR -->
                        <div class="request-workflow">
                            <div class="workflow-step active">
                                <div class="workflow-icon">
                                    <i class="fas fa-search"></i>
                                </div>
                                <small>Tìm hàng hóa</small>
                            </div>
                            <div class="workflow-step" id="requestSelectStep">
                                <div class="workflow-icon">
                                    <i class="fas fa-mouse-pointer"></i>
                                </div>
                                <small>Chọn vị trí</small>
                            </div>
                            <div class="workflow-step" id="requestStep">
                                <div class="workflow-icon">
                                    <i class="fas fa-paper-plane"></i>
                                </div>
                                <small>Gửi yêu cầu</small>
                            </div>
                        </div>

                        <!-- BƯỚC 1: TÌM HÀNG HÓA -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-search"></i>
                                Bước 1: Tìm hàng hóa cần điều chỉnh
                            </div>
                            <div class="quick-input-row">
                                <div class="input-group-compact">
                                    <div class="lookup-container">
                                        <label class="form-label-compact">
                                            <i class="fas fa-barcode text-primary"></i> Mã hàng cần điều chỉnh *
                                        </label>
                                        <input type="text" class="form-control-compact" id="requestItemCodeInput" 
                                               placeholder="Nhập mã hàng...">
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- BƯỚC 2: CHỌN VỊ TRÍ -->
                        <div class="form-section-compact" id="requestLocationSection" style="display: none;">
                            <div class="form-section-header-compact">
                                <i class="fas fa-mouse-pointer"></i>
                                Bước 2: Chọn vị trí cần điều chỉnh
                            </div>
                            <div id="requestLocationList" class="row">
                                <!-- Location cards will be inserted here -->
                            </div>
                        </div>

                        <!-- BƯỚC 3: TẠO YÊU CẦU -->
                        <div class="form-section-compact" id="requestDetailsSection" style="display: none;">
                            <div class="form-section-header-compact">
                                <i class="fas fa-paper-plane"></i>
                                Bước 3: Tạo yêu cầu chỉnh số
                            </div>
                            
                            <!-- Request Preview -->
                            <div class="adjustment-preview">
                                <div class="row mb-3">
                                    <div class="col-md-6">
                                        <strong>Sản phẩm:</strong> <span id="requestProductInfo">-</span>
                                    </div>
                                    <div class="col-md-6">
                                        <strong>Vị trí:</strong> <span id="requestLocationInfo">-</span>
                                    </div>
                                </div>
                                
                                <div class="adjustment-cards">
                                    <div class="adjustment-card current">
                                        <h6 class="text-muted">Số lượng hiện tại</h6>
                                        <div class="fs-4 fw-bold" id="requestCurrentQty">0</div>
                                    </div>
                                    <div class="adjustment-card new">
                                        <h6 class="text-muted">Số lượng đề xuất</h6>
                                        <div class="fs-4 fw-bold text-primary" id="requestNewQtyDisplay">0</div>
                                    </div>
                                    <div class="adjustment-card diff" id="requestDiffCard">
                                        <h6 class="text-muted">Chênh lệch</h6>
                                        <div class="fs-4 fw-bold" id="requestDiffDisplay">0</div>
                                    </div>
                                </div>
                            </div>

                            <div class="row">
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-sort-numeric-up text-primary"></i>
                                            Số lượng đề xuất <span class="text-danger">*</span>
                                        </label>
                                        <input type="number" class="form-control-compact" id="requestNewQuantity" 
                                               required min="0" placeholder="0">
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-comment text-primary"></i>
                                            Lý do yêu cầu chỉnh số <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="requestReason" 
                                               required placeholder="VD: Kiểm kê phát hiện chênh lệch...">
                                    </div>
                                </div>
                            </div>
                            <input type="hidden" id="requestInventoryId">
                            
                            <div class="alert alert-info mt-3">
                                <i class="fas fa-info-circle"></i>
                                <strong>Lưu ý:</strong> Yêu cầu này sẽ được gửi đến Super Admin để phê duyệt. 
                                Bạn sẽ nhận được thông báo khi yêu cầu được xử lý.
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-primary" id="confirmRequestBtn" onclick="saveAdjustRequest()" disabled>
                        <i class="fas fa-paper-plane"></i> Gửi yêu cầu
                    </button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        setupRequestModalEventListeners();
    }, 0);

    return modal;
}

function setupRequestModalEventListeners() {
    // Wait for DOM to be fully ready
    setTimeout(() => {
        const itemCodeInput = safeGetElement('requestItemCodeInput', 'request modal setup');
        const newQtyInput = safeGetElement('requestNewQuantity', 'request modal setup');
        const reasonInput = safeGetElement('requestReason', 'request modal setup');

        if (itemCodeInput) {
            itemCodeInput.addEventListener('input', debounce(handleRequestItemCodeInput, 500));
        }

        // Real-time calculation
        if (newQtyInput) {
            newQtyInput.addEventListener('input', updateRequestCalculation);
        }

        if (reasonInput) {
            reasonInput.addEventListener('input', updateRequestCalculation);
        }
    }, 100);
}

function updateRequestCalculation() {
    const currentQtyElement = safeGetElement('requestCurrentQty', 'request calculation');
    const newQtyInput = safeGetElement('requestNewQuantity', 'request calculation');
    const newQtyDisplay = safeGetElement('requestNewQtyDisplay', 'request calculation');
    const diffDisplay = safeGetElement('requestDiffDisplay', 'request calculation');
    const diffCard = safeGetElement('requestDiffCard', 'request calculation');
    const confirmBtn = safeGetElement('confirmRequestBtn', 'request calculation');
    const reasonInput = safeGetElement('requestReason', 'request calculation');

    if (!currentQtyElement || !newQtyInput) return;

    const currentQty = parseInt(currentQtyElement.textContent) || 0;
    const newQty = parseInt(newQtyInput.value) || 0;
    const diff = newQty - currentQty;

    if (newQtyDisplay) newQtyDisplay.textContent = newQty;
    if (diffDisplay) diffDisplay.textContent = diff >= 0 ? `+${diff}` : diff;

    if (diffCard) {
        diffCard.className = 'adjustment-card diff';
        if (diff < 0) diffCard.classList.add('negative');
    }

    // Update button state
    if (confirmBtn && reasonInput) {
        const hasReason = reasonInput.value.trim();
        const isValidChange = diff !== 0;
        confirmBtn.disabled = !(hasReason && isValidChange);
    }
}

window.toggleExportItemSection = function () {
    const section = document.getElementById('addExportItemSection');
    const icon = document.getElementById('exportCollapseIcon');
    const toggle = document.querySelector('#addExportItemSection .collapse-toggle');

    const isCollapsed = section.classList.contains('collapsed');

    if (isCollapsed) {
        section.classList.remove('collapsed');
        icon.className = 'fas fa-chevron-up';
        toggle.innerHTML = '<i class="fas fa-chevron-up" id="exportCollapseIcon"></i> Thu gọn';
    } else {
        section.classList.add('collapsed');
        icon.className = 'fas fa-chevron-down';
        toggle.innerHTML = '<i class="fas fa-chevron-down" id="exportCollapseIcon"></i> Mở rộng';
    }
};

async function handleRequestItemCodeInput(event) {
    const code = event.target.value.trim().toUpperCase();
    event.target.value = code;

    const locationContainer = document.getElementById('requestLocationSection');
    const locationList = document.getElementById('requestLocationList');
    const detailsContainer = document.getElementById('requestDetailsSection');
    const confirmBtn = document.getElementById('confirmRequestBtn');

    // Kiểm tra elements tồn tại trước khi sử dụng
    if (!locationContainer || !locationList || !detailsContainer || !confirmBtn) {
        console.warn('Some request modal elements not found');
        return;
    }

    // Reset giao diện về trạng thái ban đầu
    locationContainer.style.display = 'none';
    detailsContainer.style.display = 'none';
    locationList.innerHTML = '';
    confirmBtn.disabled = true;

    // Update workflow
    updateWorkflowStep('requestSelectStep', false);
    updateWorkflowStep('requestStep', false);

    if (!code) return;

    try {
        const inventoryQuery = query(
            collection(db, 'inventory'),
            where('code', '==', code)
        );
        const snapshot = await getDocs(inventoryQuery);

        if (snapshot.empty) {
            locationList.innerHTML = '<div class="col-12"><p class="text-danger p-2">Không tìm thấy sản phẩm với mã này.</p></div>';
            locationContainer.style.display = 'block';
        } else {
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const locationCard = createLocationCard(doc.id, data, 'request');
                locationList.appendChild(locationCard);
            });
            locationContainer.style.display = 'block';
            updateWorkflowStep('requestSelectStep', true);
        }
    } catch (error) {
        console.error("Error fetching item for request:", error);
        showToast('Lỗi khi tìm kiếm mã hàng', 'danger');
    }
}

function fillRequestDetails(docId, data) {
    const detailsContainer = safeGetElement('requestDetailsSection', 'request form');
    const confirmBtn = safeGetElement('confirmRequestBtn', 'request form');

    // Safely update elements
    const productInfo = safeGetElement('requestProductInfo', 'request form');
    const locationInfo = safeGetElement('requestLocationInfo', 'request form');
    const currentQty = safeGetElement('requestCurrentQty', 'request form');
    const newQuantityInput = safeGetElement('requestNewQuantity', 'request form');
    const inventoryIdInput = safeGetElement('requestInventoryId', 'request form');

    if (productInfo) productInfo.textContent = data.name;
    if (locationInfo) locationInfo.textContent = data.location;
    if (currentQty) currentQty.textContent = data.quantity;
    if (newQuantityInput) {
        newQuantityInput.value = data.quantity;
        newQuantityInput.focus();
        newQuantityInput.select();
    }
    if (inventoryIdInput) inventoryIdInput.value = docId;

    if (detailsContainer) detailsContainer.style.display = 'block';
    if (confirmBtn) confirmBtn.disabled = false;

    // Update workflow
    updateWorkflowStep('requestStep', true);

    // Trigger calculation update
    updateRequestCalculation();
}

window.saveAdjustRequest = async function () {
    try {
        // Safe element retrieval
        const inventoryIdInput = safeGetElement('requestInventoryId', 'save adjust request');
        const currentQuantityElement = safeGetElement('requestCurrentQty', 'save adjust request');
        const newQuantityInput = safeGetElement('requestNewQuantity', 'save adjust request');
        const reasonInput = safeGetElement('requestReason', 'save adjust request');

        if (!inventoryIdInput || !currentQuantityElement || !newQuantityInput || !reasonInput) {
            showToast('Không thể lấy dữ liệu từ form. Vui lòng thử lại.', 'danger');
            return;
        }

        const inventoryId = inventoryIdInput.value;
        const currentQuantity = parseInt(currentQuantityElement.textContent) || 0;
        const newQuantityStr = newQuantityInput.value;
        const reason = reasonInput.value.trim();

        // Validation
        if (!inventoryId) {
            showToast('Vui lòng chọn một vị trí để điều chỉnh.', 'warning');
            return;
        }

        if (newQuantityStr === '' || isNaN(parseInt(newQuantityStr))) {
            showToast('Vui lòng nhập số lượng mới hợp lệ.', 'warning');
            newQuantityInput.focus();
            return;
        }

        const newQuantity = parseInt(newQuantityStr);
        if (newQuantity < 0) {
            showToast('Số lượng mới không được âm.', 'warning');
            newQuantityInput.focus();
            return;
        }

        if (!reason) {
            showToast('Vui lòng nhập lý do yêu cầu chỉnh số.', 'warning');
            reasonInput.focus();
            return;
        }

        if (newQuantity === currentQuantity) {
            showToast('Số lượng mới giống số lượng hiện tại.', 'info');
            return;
        }

        // Get inventory data
        const inventoryRef = doc(db, 'inventory', inventoryId);
        const inventorySnap = await getDoc(inventoryRef);

        if (!inventorySnap.exists()) {
            showToast('Không tìm thấy thông tin tồn kho.', 'danger');
            return;
        }

        const inventoryData = inventorySnap.data();

        // Create adjustment request
        await addDoc(collection(db, 'adjustment_requests'), {
            inventoryId: inventoryId,
            itemCode: inventoryData.code,
            itemName: inventoryData.name,
            location: inventoryData.location,
            currentQuantity: currentQuantity,
            requestedQuantity: newQuantity,
            adjustment: newQuantity - currentQuantity,
            reason: reason,
            status: 'pending',
            requestedBy: currentUser.uid,
            requestedByName: currentUser.name,
            requestDate: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        showToast('Yêu cầu chỉnh số đã được gửi thành công!', 'success');

        // Close modal safely
        const modal = document.getElementById('adjustRequestModal');
        if (modal) {
            const bsModal = bootstrap.Modal.getInstance(modal);
            if (bsModal) {
                bsModal.hide();
            }
        }

        // Reload data
        loadAdjustRequests();

    } catch (error) {
        console.error('Error saving adjust request:', error);
        showToast('Lỗi khi gửi yêu cầu chỉnh số.', 'danger');
    }
};

window.removeExportItem = async function (index) {
    const confirmed = await showConfirmation(
        'Xóa mặt hàng',
        'Bạn có chắc muốn xóa mặt hàng này khỏi phiếu xuất?',
        'Xóa',
        'Hủy',
        'danger'
    );

    if (confirmed) {
        currentExportItems.splice(index, 1);
        updateExportItemsTable();
        showToast('Đã xóa mặt hàng khỏi phiếu xuất', 'success');
    }
};

async function loadAdjustRequests(useFilter = false) {
    try {
        let constraints = [];

        if (useFilter) {
            const fromDate = document.getElementById('requestFromDate')?.value;
            const toDate = document.getElementById('requestToDate')?.value;
            const status = document.getElementById('requestStatusFilter')?.value;

            if (fromDate) {
                const startDate = new Date(fromDate);
                constraints.push(where('timestamp', '>=', startDate));
            }

            if (toDate) {
                const endDate = new Date(toDate);
                endDate.setHours(23, 59, 59, 999);
                constraints.push(where('timestamp', '<=', endDate));
            }

            if (status) {
                constraints.push(where('status', '==', status));
            }
        }

        constraints.push(orderBy('timestamp', 'desc'));

        const requestsQuery = query(collection(db, 'adjustment_requests'), ...constraints);
        const snapshot = await getDocs(requestsQuery);

        const content = document.getElementById('adjustRequestContent');

        if (snapshot.empty) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy yêu cầu chỉnh số nào.</p>';
            return;
        }

        createAdjustRequestPagination(snapshot.docs, content);

    } catch (error) {
        console.error('Error loading adjust requests:', error);
        showToast('Lỗi tải danh sách yêu cầu chỉnh số', 'danger');
    }
}

function createAdjustRequestPagination(allData, container) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Mã hàng</th>
                    <th>Tên mô tả</th>
                    <th>Vị trí</th>
                    <th>SL hiện tại</th>
                    <th>SL đề xuất</th>
                    <th>Trạng thái</th>
                    <th>Ngày yêu cầu</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        pageData.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');

            const date = data.timestamp ?
                data.timestamp.toDate().toLocaleDateString('vi-VN') :
                'N/A';

            const statusConfig = {
                'pending': { class: 'bg-warning text-dark', text: 'Chờ duyệt' },
                'approved': { class: 'bg-success', text: 'Đã duyệt' },
                'rejected': { class: 'bg-danger', text: 'Từ chối' }
            };

            const status = statusConfig[data.status] || { class: 'bg-secondary', text: data.status };

            row.innerHTML = `
                <td>${data.itemCode}</td>
                <td>${data.itemName}</td>
                <td>${data.location}</td>
                <td>${data.currentQuantity}</td>
                <td>${data.requestedQuantity}</td>
                <td><span class="badge ${status.class}">${status.text}</span></td>
                <td>${date}</td>
                <td>
                    <button class="btn btn-info btn-sm" onclick="viewAdjustRequestDetails('${doc.id}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>
                </td>
            `;

            tbody.appendChild(row);
        });

        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="Adjust request pagination">
                <ul class="pagination pagination-sm mb-0" id="adjustRequestPagination">
                </ul>
            </nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);

        updatePaginationControls(page, totalPages, 'adjustRequestPagination', renderPage);
    }

    renderPage(1);
}

window.saveExport = async function () {
    if (currentExportItems.length === 0) {
        showToast('Vui lòng thêm ít nhất một mặt hàng', 'warning');
        return;
    }

    const exportNumber = document.getElementById('exportNumber').value;
    const recipient = document.getElementById('recipient').value;

    if (!exportNumber || !recipient) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);

        // Create export transaction - THÊM availableQuantity vào items
        const exportDoc = doc(collection(db, 'transactions'));
        const itemsForSave = currentExportItems.map(item => ({
            inventoryId: item.inventoryId,
            code: item.code,
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            availableQuantityBefore: item.availableQuantity || 0  // Lưu tồn kho trước khi xuất
        }));

        batch.set(exportDoc, {
            type: 'export',
            exportNumber: exportNumber,
            recipient: recipient,
            items: itemsForSave,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        // Update inventory quantities
        for (const item of currentExportItems) {
            const inventoryDoc = doc(db, 'inventory', item.inventoryId);
            batch.update(inventoryDoc, {
                quantity: increment(-item.quantity)
            });
        }

        await batch.commit();

        showToast('Xuất kho thành công!', 'success');

        bootstrap.Modal.getInstance(document.querySelector('.modal')).hide();
        currentExportItems = [];
        loadExportHistory();

    } catch (error) {
        console.error('Error saving export:', error);
        showToast('Lỗi lưu phiếu xuất', 'danger');
    }
};


function createTransferPagination(allData, container) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        // Create table
        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Mã hàng</th>
                    <th>Số lượng</th>
                    <th>Từ vị trí</th>
                    <th>Đến vị trí</th>
                    <th>Người thực hiện</th>
                    <th>Ngày chuyển</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        pageData.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');

            const date = data.timestamp ?
                data.timestamp.toDate().toLocaleDateString('vi-VN') :
                'N/A';

            // Tạo nút thao tác dựa trên quyền
            let actionButtons = `
                <button class="btn btn-info btn-sm me-1" onclick="viewTransferDetails('${doc.id}')">
                    <i class="fas fa-eye"></i> Xem
                </button>
            `;

            // Chỉ Super Admin mới thấy nút sửa/xóa
            if (userRole === 'super_admin') {
                actionButtons += `
                    <button class="btn btn-warning btn-sm me-1" onclick="editTransferTransaction('${doc.id}')">
                        <i class="fas fa-edit"></i> Sửa
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteTransferTransaction('${doc.id}')">
                        <i class="fas fa-trash"></i> Xóa
                    </button>
                `;
            }

            row.innerHTML = `
                <td>${data.itemCode}</td>
                <td><strong>${data.quantity || 0}</strong></td>
                <td>${data.fromLocation}</td>
                <td>${data.toLocation}</td>
                <td>${data.performedByName}</td>
                <td>${date}</td>
                <td>${actionButtons}</td>
            `;

            tbody.appendChild(row);
        });

        // Create pagination
        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="Transfer pagination">
                <ul class="pagination pagination-sm mb-0" id="transferPagination">
                </ul>
            </nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);

        updatePaginationControls(page, totalPages, 'transferPagination', renderPage);
    }

    renderPage(1);
}

// THAY THẾ TOÀN BỘ HÀM NÀY BẰNG PHIÊN BẢN MỚI

async function loadExportHistory(useFilter = false) {
    try {
        const fromDate = document.getElementById('exportFromDate')?.value;
        const toDate = document.getElementById('exportToDate')?.value;
        let endDate = null;
        if (toDate) {
            endDate = new Date(toDate);
            endDate.setHours(23, 59, 59, 999);
        }

        // --- LẤY DỮ LIỆU TỪ 2 NƠI ---
        
        // 1. Lấy các phiếu đã hoàn thành
        let completedExports = [];
        const completedQuery = query(
            collection(db, 'transactions'),
            where('type', '==', 'export'),
            orderBy('timestamp', 'desc')
        );
        const completedSnapshot = await getDocs(completedQuery);
        completedSnapshot.forEach(doc => {
            const data = doc.data();
            data.docId = doc.id;
            data.dataType = 'completed'; // Đánh dấu để phân biệt
            completedExports.push(data);
        });

        // 2. Lấy các yêu cầu đang chờ duyệt (chỉ admin và super_admin thấy)
        let pendingRequests = [];
        if (userRole !== 'staff') {
            const pendingQuery = query(
                collection(db, 'export_requests'),
                where('status', '==', 'pending'),
                orderBy('timestamp', 'desc')
            );
            const pendingSnapshot = await getDocs(pendingQuery);
            pendingSnapshot.forEach(doc => {
                const data = doc.data();
                data.docId = doc.id;
                data.dataType = 'pending'; // Đánh dấu để phân biệt
                pendingRequests.push(data);
            });
        }
        
        // 3. Gộp và sắp xếp lại tất cả
        let allData = [...pendingRequests, ...completedExports];
        allData.sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis());

        // --- ÁP DỤNG BỘ LỌC PHÍA CLIENT ---
        if (useFilter) {
            const itemCodeFilter = document.getElementById('exportItemCodeFilter')?.value.toLowerCase();
            
            allData = allData.filter(doc => {
                const docDate = doc.timestamp.toDate();
                if (fromDate && docDate < new Date(fromDate)) return false;
                if (endDate && docDate > endDate) return false;

                if (itemCodeFilter) {
                    return doc.items?.some(item => item.code?.toLowerCase().includes(itemCodeFilter));
                }
                return true;
            });
        }

        const content = document.getElementById('exportContent');
        if (allData.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy phiếu xuất hoặc yêu cầu nào.</p>';
            return;
        }

        // Tạo bảng và phân trang
        createExportPagination(allData, content);

    } catch (error) {
        console.error('Lỗi tải lịch sử xuất kho:', error);
        showToast('Lỗi tải lịch sử xuất kho', 'danger');
    }
}


window.viewExportDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu xuất', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createExportDetailsModal(data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading export details:', error);
        showToast('Lỗi tải chi tiết phiếu xuất', 'danger');
    }
};

// Thay thế hàm createExportDetailsModal() cũ
function createExportDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const totalItems = data.items?.length || 0;
    const totalQuantity = data.items?.reduce((sum, item) => sum + (item.quantity || 0), 0) || 0;

    // Logic hiển thị thông tin người thực hiện
    let performerInfoHtml = '';
    if (data.requestInfo) {
        // Nếu phiếu được tạo từ một yêu cầu
        performerInfoHtml = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestInfo.requestedByName || 'N/A'}</div>
            <div class="col-md-6"><strong>Người duyệt & xuất:</strong> ${data.performedByName}</div>
        `;
    } else {
        // Nếu là phiếu xuất trực tiếp
        performerInfoHtml = `<div class="col-md-6"><strong>Người xuất kho:</strong> ${data.performedByName}</div>`;
    }

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-warning text-dark">
                    <h5 class="modal-title">
                        <i class="fas fa-upload"></i> Chi tiết phiếu xuất kho
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning d-flex align-items-center mb-4">
                        <i class="fas fa-check-circle fa-2x me-3"></i>
                        <div>
                            <strong>Xuất kho thành công</strong><br>
                            <small>Đã xuất ${totalItems} mặt hàng với tổng số lượng ${totalQuantity} khỏi kho</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG - ĐÃ CẬP NHẬT -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-12 mb-2">
                            <span class="badge bg-warning text-dark">
                                <i class="fas fa-upload"></i> Phiếu xuất kho
                            </span>
                        </div>
                        <div class="col-md-6"><strong>Số phiếu:</strong> ${data.exportNumber}</div>
                        <div class="col-md-6"><strong>Người nhận:</strong> ${data.recipient}</div>
                        ${performerInfoHtml}
                        <div class="col-md-6"><strong>Ngày xuất:</strong> ${date}</div>
                        <div class="col-md-6"><strong>Tổng số mặt hàng:</strong> ${totalItems}</div>
                        <div class="col-md-6"><strong>Tổng số lượng:</strong> ${totalQuantity}</div>
                    </div>                    
                    
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-list me-2"></i>Danh sách hàng hóa đã xuất
                    </h6>
                    <div class="table-responsive">
                        <table class="table table-bordered table-compact" >
                            <thead class="table-warning" >
                                <tr>
                                    <th>STT</th>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Số lượng xuất</th>
                                    <th>Đơn vị tính</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${data.items?.map((item, index) => `
                                    <tr>
                                        <td class="text-center">${index + 1}</td>
                                        <td><strong>${item.code}</strong></td>
                                        <td>${item.name}</td>
                                        <td class="text-center"><strong class="text-warning">${item.quantity}</strong></td>
                                        <td class="text-center">${item.unit || ''}</td>
                                    </tr>
                                `).join('') || '<tr><td colspan="5" class="text-center">Không có dữ liệu</td></tr>'}
                            </tbody>
                        </table>
                    </div>

                    <div class="alert alert-info mt-3">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> Số lượng hàng hóa đã được trừ khỏi tồn kho.
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}


export function loadPendingAdjustmentsSection() {
    loadPendingAdjustments();
}

async function loadPendingAdjustments() {
    if (userRole !== 'super_admin') return;

    try {
        const pendingQuery = query(
            collection(db, 'adjustment_requests'),
            where('status', '==', 'pending'),
            orderBy('timestamp', 'desc')
        );
        const snapshot = await getDocs(pendingQuery);

        const content = document.getElementById('pendingAdjustmentsContent');
        content.innerHTML = '';

        if (snapshot.empty) {
            content.innerHTML = '<p class="text-muted">Không có yêu cầu chỉnh số nào chờ duyệt.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'table table-striped';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Mã hàng</th>
                    <th>Tên mô tả</th>
                    <th>Vị trí</th>
                    <th>SL hiện tại</th>
                    <th>SL đề xuất</th>
                    <th>Chênh lệch</th>
                    <th>Người yêu cầu</th>
                    <th>Ngày yêu cầu</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody id="pendingAdjustmentsTable"></tbody>
        `;

        const tbody = table.querySelector('tbody');

        snapshot.forEach(doc => {
            const data = doc.data();
            const row = document.createElement('tr');

            const requestDate = data.timestamp ?
                data.timestamp.toDate().toLocaleDateString('vi-VN') :
                'N/A';

            const adjustment = data.adjustment || 0;
            const adjustmentClass = adjustment > 0 ? 'text-success' : adjustment < 0 ? 'text-danger' : '';
            const adjustmentSymbol = adjustment > 0 ? '+' : '';

            row.innerHTML = `
                <td>${data.itemCode}</td>
                <td>${data.itemName}</td>
                <td>${data.location}</td>
                <td>${data.currentQuantity}</td>
                <td>${data.requestedQuantity}</td>
                <td class="${adjustmentClass}">${adjustmentSymbol}${adjustment}</td>
                <td>${data.requestedByName}</td>
                <td>${requestDate}</td>
                <td>
                    <button class="btn btn-info btn-sm me-1" onclick="viewAdjustRequestDetails('${doc.id}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>
                    <button class="btn btn-success btn-sm me-1" onclick="approveAdjustRequest('${doc.id}')">
                        <i class="fas fa-check"></i> Duyệt
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="rejectAdjustRequest('${doc.id}')">
                        <i class="fas fa-times"></i> Từ chối
                    </button>
                </td>
            `;

            tbody.appendChild(row);
        });

        content.appendChild(table);

    } catch (error) {
        console.error('Error loading pending adjustments:', error);
        showToast('Lỗi tải danh sách yêu cầu chỉnh số chờ duyệt', 'danger');
    }
}

window.approveAdjustRequest = async function (requestId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    const confirmed = await showConfirmation(
        'Duyệt yêu cầu chỉnh số',
        'Bạn có chắc muốn duyệt yêu cầu chỉnh số này?<br><br>Sau khi duyệt, tồn kho sẽ được cập nhật theo số lượng đề xuất.',
        'Duyệt yêu cầu',
        'Hủy',
        'question'
    );

    if (!confirmed) return;

    try {
        const requestDoc = await getDoc(doc(db, 'adjustment_requests', requestId));
        const requestData = requestDoc.data();

        const batch = writeBatch(db);

        // Update inventory
        const inventoryRef = doc(db, 'inventory', requestData.inventoryId);
        batch.update(inventoryRef, {
            quantity: requestData.requestedQuantity
        });

        // Update request status
        batch.update(doc(db, 'adjustment_requests', requestId), {
            status: 'approved',
            approvedBy: currentUser.uid,
            approvedByName: currentUser.name,
            approvedDate: serverTimestamp()
        });

        // Log the adjustment transaction
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'adjust',
            inventoryId: requestData.inventoryId,
            itemCode: requestData.itemCode,
            itemName: requestData.itemName,
            location: requestData.location,
            previousQuantity: requestData.currentQuantity,
            newQuantity: requestData.requestedQuantity,
            adjustment: requestData.adjustment,
            reason: requestData.reason,
            requestId: requestId,
            requestedBy: requestData.requestedBy,
            requestedByName: requestData.requestedByName,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã duyệt yêu cầu chỉnh số thành công', 'success');
        loadPendingAdjustments();

        // Cập nhật badge count
        updatePendingAdjustmentsBadge();

    } catch (error) {
        console.error('Error approving adjustment request:', error);
        showToast('Lỗi duyệt yêu cầu chỉnh số', 'danger');
    }
};

// Cập nhật hàm rejectAdjustRequest
window.rejectAdjustRequest = async function (requestId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    const reason = await showInputModal(
        'Từ chối yêu cầu chỉnh số',
        'Vui lòng nhập lý do từ chối yêu cầu này:',
        'Nhập lý do từ chối...',
        'text'
    );

    if (!reason) return;

    try {
        // Lấy thông tin yêu cầu trước khi cập nhật
        const requestDoc = await getDoc(doc(db, 'adjustment_requests', requestId));
        const requestData = requestDoc.data();

        const batch = writeBatch(db);

        // Cập nhật trạng thái yêu cầu
        batch.update(doc(db, 'adjustment_requests', requestId), {
            status: 'rejected',
            rejectedBy: currentUser.uid,
            rejectedByName: currentUser.name,
            rejectedDate: serverTimestamp(),
            rejectionReason: reason
        });

        // Tạo transaction log cho việc từ chối
        const rejectionLogRef = doc(collection(db, 'transactions'));
        batch.set(rejectionLogRef, {
            type: 'adjust_rejected',
            requestId: requestId,
            inventoryId: requestData.inventoryId,
            itemCode: requestData.itemCode,
            itemName: requestData.itemName,
            location: requestData.location,
            currentQuantity: requestData.currentQuantity,
            requestedQuantity: requestData.requestedQuantity,
            adjustment: requestData.adjustment,
            reason: requestData.reason,
            rejectionReason: reason,
            requestedBy: requestData.requestedBy,
            requestedByName: requestData.requestedByName,
            requestDate: requestData.timestamp,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã từ chối yêu cầu chỉnh số', 'success');
        loadPendingAdjustments();
        updatePendingAdjustmentsBadge();

    } catch (error) {
        console.error('Error rejecting adjustment request:', error);
        showToast('Lỗi từ chối yêu cầu chỉnh số', 'danger');
    }
};


async function updatePendingAdjustmentsBadge() {
    try {
        const pendingQuery = query(
            collection(db, 'adjustment_requests'),
            where('status', '==', 'pending')
        );
        const snapshot = await getDocs(pendingQuery);

        const count = snapshot.size;
        const pendingCountElement = document.getElementById('pendingAdjustmentCount');
        const pendingNavElement = document.getElementById('pendingAdjustmentsNav');

        if (pendingCountElement) {
            pendingCountElement.textContent = count;
        }

        if (pendingNavElement) {
            if (count > 0) {
                pendingNavElement.style.display = 'block';
            } else {
                pendingNavElement.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Error updating badge:', error);
    }
}

// View adjustment request details
window.viewAdjustRequestDetails = async function (requestId) {
    try {
        const docSnap = await getDoc(doc(db, 'adjustment_requests', requestId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy yêu cầu chỉnh số', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createAdjustRequestDetailsModal(data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading adjustment request details:', error);
        showToast('Lỗi tải chi tiết yêu cầu chỉnh số', 'danger');
    }
};

// Thay thế hàm createAdjustRequestDetailsModal() cũ
function createAdjustRequestDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const requestDate = data.requestDate ? (data.requestDate.toDate ? data.requestDate.toDate().toLocaleString('vi-VN') : data.requestDate) : 'N/A';
    const approvedDate = data.approvedDate ? (data.approvedDate.toDate ? data.approvedDate.toDate().toLocaleString('vi-VN') : 'N/A') : (data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A');
    const rejectedDate = data.rejectedDate ? (data.rejectedDate.toDate ? data.rejectedDate.toDate().toLocaleString('vi-VN') : 'N/A') : 'N/A';
    
    const adjustment = data.adjustment || 0;
    const adjustmentClass = adjustment > 0 ? 'text-success' : adjustment < 0 ? 'text-danger' : '';
    const adjustmentSymbol = adjustment > 0 ? '+' : '';

    const statusConfig = {
        'pending': { class: 'bg-warning text-dark', text: 'Chờ duyệt', icon: 'fas fa-clock' },
        'approved': { class: 'bg-success', text: 'Đã duyệt', icon: 'fas fa-check-circle' },
        'rejected': { class: 'bg-danger', text: 'Từ chối', icon: 'fas fa-times-circle' }
    };
    const status = statusConfig[data.status] || { class: 'bg-secondary', text: data.status, icon: 'fas fa-question-circle' };
    
    let infoHtml = '';
    let headerClass = 'modal-header';
    let headerTitle = 'Chi tiết Yêu cầu Chỉnh số';
    let alertHtml = '';

    if (data.status === 'approved') {
        headerClass = 'modal-header bg-success text-white';
        alertHtml = `<div class="alert alert-success d-flex align-items-center mb-4"><i class="fas fa-check-circle fa-2x me-3"></i><div><strong>Đã thực hiện thành công</strong><br><small>Tồn kho đã được cập nhật theo yêu cầu</small></div></div>`;
        if (data.requestId) { // Từ yêu cầu
            headerTitle = 'Chi tiết Chỉnh số (từ yêu cầu đã duyệt)';
            infoHtml = `
                <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
                <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
                <div class="col-md-6"><strong>Người duyệt:</strong> ${data.approvedByName}</div>
                <div class="col-md-6"><strong>Ngày duyệt:</strong> ${approvedDate}</div>
            `;
        } else { // Chỉnh số trực tiếp
            headerTitle = 'Chi tiết Chỉnh số (trực tiếp)';
             infoHtml = `
                <div class="col-md-6"><strong>Người chỉnh số:</strong> ${data.approvedByName}</div>
                <div class="col-md-6"><strong>Ngày chỉnh số:</strong> ${approvedDate}</div>
            `;
        }
    } else if (data.status === 'rejected') {
        headerClass = 'modal-header bg-danger text-white';
        headerTitle = 'Chi tiết Yêu cầu (đã từ chối)';
        alertHtml = `<div class="alert alert-danger d-flex align-items-center mb-4"><i class="fas fa-exclamation-triangle fa-2x me-3"></i><div><strong>Yêu cầu đã bị từ chối</strong><br><small>Không có thay đổi nào được thực hiện trên tồn kho</small></div></div>`;
        infoHtml = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
            <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
            <div class="col-md-6"><strong>Người từ chối:</strong> ${data.rejectedByName}</div>
            <div class="col-md-6"><strong>Ngày từ chối:</strong> ${rejectedDate}</div>
            <div class="col-12 mt-2"><strong>Lý do từ chối:</strong><p class="ms-2 mt-1 mb-0 fst-italic bg-danger bg-opacity-10 p-2 rounded text-danger">${data.rejectionReason || 'Không có lý do cụ thể'}</p></div>
        `;
    } else { // pending
         alertHtml = `<div class="alert alert-warning d-flex align-items-center mb-4"><i class="fas fa-clock me-2"></i><small>Yêu cầu đang chờ được xem xét bởi Super Admin</small></div>`;
         infoHtml = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
            <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
        `;
    }

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="${headerClass}">
                    <h5 class="modal-title"><i class="${status.icon}"></i> ${headerTitle}</h5>
                    <button type="button" class="btn-close ${headerClass.includes('text-white') ? 'btn-close-white' : ''}" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    ${alertHtml}
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-md-6"><strong>Mã hàng:</strong> ${data.itemCode}</div>
                        <div class="col-md-6"><strong>Tên mô tả:</strong> ${data.itemName}</div>
                        <div class="col-md-6"><strong>Vị trí:</strong> ${data.location}</div>
                        <div class="col-md-6"><strong>Trạng thái:</strong> <span class="badge ${status.class}">${status.text}</span></div>
                        ${infoHtml}
                    </div>
                    <h6 class="text-muted mb-3"><i class="fas fa-exchange-alt me-2"></i>Chi tiết thay đổi đề xuất</h6>
                    <div class="row text-center mb-4">
                        <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Số lượng hiện tại</h6><p class="card-text fs-4">${data.currentQuantity}</p></div></div></div>
                        <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Số lượng đề xuất</h6><p class="card-text fs-4 fw-bold ${data.status === 'rejected' ? 'text-muted' : 'text-primary'}">${data.status === 'rejected' ? `<s>${data.requestedQuantity}</s>` : data.requestedQuantity}</p></div></div></div>
                        <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Chênh lệch</h6><p class="card-text fs-4 fw-bold ${data.status === 'rejected' ? 'text-muted' : adjustmentClass}">${data.status === 'rejected' ? `<s>${adjustmentSymbol}${adjustment}</s>` : `${adjustmentSymbol}${adjustment}`}</p></div></div></div>
                    </div>
                    <div class="mb-3"><strong>Lý do yêu cầu:</strong><p class="ms-2 mt-1 mb-0 fst-italic bg-light p-2 rounded">${data.reason}</p></div>
                </div>
                <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button></div>
            </div>
        </div>
    `;
    return modal;
}


export function loadTransferSection() {
    loadTransferHistory();
}

// Thay thế hàm này trong warehouse.js

function showTransferModal() {
    const lastFocusedElement = document.activeElement;
    const modal = createTransferModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        document.getElementById('transferItemCodeInput').focus();
    });

    modal.addEventListener('hidden.bs.modal', () => {
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
        modal.remove();
    });

    bsModal.show();
}

function createTransferModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'transferModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-info text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-exchange-alt"></i> Tạo phiếu chuyển kho
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="transferForm" onsubmit="return false;">
                        <!-- TÌM HÀNG HÓA CHUYỂN -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-search"></i>
                                Tìm hàng hóa cần chuyển
                            </div>
                            <div class="quick-input-row">
                                <div class="row align-items-end">
                                    <div class="col-md-4">
                                        <label class="form-label-compact">
                                            <i class="fas fa-barcode text-info"></i> Mã hàng cần chuyển *
                                        </label>
                                        <div class="autocomplete-container-compact">
                                            <input type="text" class="form-control-compact" id="transferItemCodeInput" 
                                                   placeholder="Nhập mã hàng..." autocomplete="off">
                                            <input type="hidden" id="sourceInventoryId">
                                        </div>
                                    </div>
                                    <div class="col-md-3">
                                        <label class="form-label-compact">
                                            <i class="fas fa-tag text-info"></i> Tên sản phẩm
                                        </label>
                                        <input type="text" class="form-control-compact" id="transferItemName" readonly>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact">
                                            <i class="fas fa-warehouse text-info"></i> Tồn kho
                                        </label>
                                        <input type="text" class="form-control-compact" id="transferCurrentStock" readonly>
                                    </div>
                                    <div class="col-md-3">
                                        <label class="form-label-compact">
                                            <i class="fas fa-map-marker-alt text-info"></i> Vị trí hiện tại
                                        </label>
                                        <input type="text" class="form-control-compact" id="transferCurrentLocation" readonly>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- THÔNG TIN CHUYỂN KHO -->
                        <div class="form-section-compact" id="transferDetailsSection" style="display: none;">
                            <div class="form-section-header-compact">
                                <i class="fas fa-route"></i>
                                Thông tin chuyển kho
                            </div>
                            
                            <!-- Transfer Path Visualization -->
                            <div class="transfer-path">
                                <div class="transfer-location">
                                    <small class="text-muted">TỪ VỊ TRÍ</small><br>
                                    <span class="location-badge" id="fromLocationDisplay">-</span>
                                </div>
                                <div class="transfer-arrow">
                                    <i class="fas fa-arrow-right"></i>
                                </div>
                                <div class="transfer-location">
                                    <small class="text-muted">ĐẾN VỊ TRÍ</small><br>
                                    <span class="location-badge bg-success" id="toLocationDisplay">Chưa chọn</span>
                                </div>
                            </div>

                            <div class="row">
                                <div class="col-md-4">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-sort-numeric-up text-info"></i>
                                            Số lượng chuyển <span class="text-danger">*</span>
                                        </label>
                                        <input type="number" class="form-control-compact" id="transferQuantity" 
                                               required min="1" placeholder="0">
                                    </div>
                                </div>
                                <div class="col-md-4">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-map-marker-alt text-info"></i>
                                            Chuyển đến vị trí <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="transferNewLocation" 
                                               required placeholder="VD: B2-05">
                                    </div>
                                </div>
                                <div class="col-md-4">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-sticky-note text-info"></i>
                                            Ghi chú
                                        </label>
                                        <input type="text" class="form-control-compact" id="transferNote" 
                                               placeholder="Lý do chuyển kho...">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-info" onclick="saveTransfer()" id="saveTransferBtn" disabled>
                        <i class="fas fa-exchange-alt"></i> Xác nhận chuyển kho
                    </button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        setupTransferModalEventListeners();
    }, 0);

    return modal;
}

function setupTransferModalEventListeners() {
    const itemCodeInput = document.getElementById('transferItemCodeInput');

    if (itemCodeInput) {
        itemCodeInput.addEventListener('input', debounce(handleTransferItemCodeInput, 500));
    }

    // Update new location display
    document.getElementById('transferNewLocation')?.addEventListener('input', updateTransferLocationDisplay);
    document.getElementById('transferQuantity')?.addEventListener('input', updateTransferSaveButtonState);
}

function updateTransferLocationDisplay() {
    const newLocation = document.getElementById('transferNewLocation').value.trim();
    const display = document.getElementById('toLocationDisplay');

    if (newLocation) {
        display.textContent = newLocation;
        display.className = 'location-badge bg-success';
    } else {
        display.textContent = 'Chưa chọn';
        display.className = 'location-badge';
    }

    updateTransferSaveButtonState();
}


async function handleTransferItemCodeInput(event) {
    const code = event.target.value.trim().toUpperCase();
    event.target.value = code;

    const nameInput = document.getElementById('transferItemName');
    const stockInput = document.getElementById('transferCurrentStock');
    const locationInput = document.getElementById('transferCurrentLocation');
    const detailsSection = document.getElementById('transferDetailsSection');
    const hiddenIdInput = document.getElementById('sourceInventoryId');

    // Reset fields
    nameInput.value = '';
    stockInput.value = '';
    locationInput.value = '';
    hiddenIdInput.value = '';
    detailsSection.style.display = 'none';

    if (!code) return;

    try {
        const inventoryQuery = query(
            collection(db, 'inventory'),
            where('code', '==', code),
            limit(1)
        );
        const snapshot = await getDocs(inventoryQuery);

        if (snapshot.empty) {
            nameInput.value = 'Không tìm thấy sản phẩm';
        } else {
            const doc = snapshot.docs[0];
            const data = doc.data();

            nameInput.value = data.name;
            stockInput.value = data.quantity;
            locationInput.value = data.location;
            hiddenIdInput.value = doc.id;

            // Update transfer path display
            document.getElementById('fromLocationDisplay').textContent = data.location;

            if (data.quantity > 0) {
                detailsSection.style.display = 'block';
                document.getElementById('transferQuantity').max = data.quantity;
                document.getElementById('transferQuantity').focus();
            } else {
                showToast('Hàng đã hết tồn kho tại vị trí này', 'warning');
            }
        }
    } catch (error) {
        console.error("Error fetching item for transfer:", error);
        nameInput.value = 'Lỗi truy vấn';
        showToast('Lỗi khi tìm kiếm mã hàng', 'danger');
    }
}

async function loadInventoryForTransfer() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'), orderBy('name'));
        const snapshot = await getDocs(inventoryQuery);

        const select = document.getElementById('transferInventorySelect');
        select.innerHTML = '<option value="">-- Chọn mặt hàng --</option>';

        snapshot.forEach(doc => {
            const data = doc.data();
            const option = document.createElement('option');
            option.value = doc.id;
            option.textContent = `${data.code} - ${data.name}`;
            option.dataset.location = data.location;
            select.appendChild(option);
        });

        select.addEventListener('change', function () {
            const selectedOption = this.options[this.selectedIndex];
            document.getElementById('currentLocation').value = selectedOption.dataset.location || '';
        });

    } catch (error) {
        console.error('Error loading inventory for transfer:', error);
        showToast('Lỗi tải danh sách tồn kho', 'danger');
    }
}

window.saveTransfer = async function () {
    try {
        // Safe element retrieval
        const sourceInventoryIdInput = safeGetElement('sourceInventoryId', 'save transfer');
        const transferQuantityInput = safeGetElement('transferQuantity', 'save transfer');
        const newLocationInput = safeGetElement('transferNewLocation', 'save transfer');
        const currentStockInput = safeGetElement('transferCurrentStock', 'save transfer');
        const currentLocationInput = safeGetElement('transferCurrentLocation', 'save transfer');
        const noteInput = safeGetElement('transferNote', 'save transfer');

        if (!sourceInventoryIdInput || !transferQuantityInput || !newLocationInput ||
            !currentStockInput || !currentLocationInput) {
            showToast('Không thể lấy dữ liệu từ form. Vui lòng thử lại.', 'danger');
            return;
        }

        const sourceInventoryId = sourceInventoryIdInput.value;
        const transferQuantity = parseInt(transferQuantityInput.value);
        const newLocation = newLocationInput.value.trim().toUpperCase();
        const currentStock = parseInt(currentStockInput.value);
        const currentLocation = currentLocationInput.value;
        const note = noteInput ? noteInput.value : '';

        // Validation
        if (!sourceInventoryId) {
            showToast('Vui lòng nhập mã hàng hợp lệ.', 'warning');
            return;
        }

        if (isNaN(transferQuantity) || transferQuantity <= 0) {
            showToast('Vui lòng nhập số lượng chuyển hợp lệ.', 'warning');
            transferQuantityInput.focus();
            return;
        }

        if (!newLocation) {
            showToast('Vui lòng nhập vị trí mới.', 'warning');
            newLocationInput.focus();
            return;
        }

        if (newLocation === currentLocation) {
            showToast('Vị trí mới phải khác vị trí hiện tại.', 'warning');
            newLocationInput.focus();
            return;
        }

        if (transferQuantity > currentStock) {
            showToast(`Số lượng chuyển (${transferQuantity}) vượt quá tồn kho (${currentStock}).`, 'danger');
            transferQuantityInput.focus();
            return;
        }

        // Confirmation
        const confirmed = await showConfirmation(
            'Xác nhận chuyển kho',
            `Bạn có chắc muốn chuyển ${transferQuantity} sản phẩm từ <strong>${currentLocation}</strong> đến <strong>${newLocation}</strong>?`,
            'Chuyển kho',
            'Hủy',
            'info'
        );

        if (!confirmed) return;

        // Get source inventory data
        const sourceDocRef = doc(db, 'inventory', sourceInventoryId);
        const sourceDocSnap = await getDoc(sourceDocRef);

        if (!sourceDocSnap.exists()) {
            showToast('Không tìm thấy thông tin tồn kho nguồn.', 'danger');
            return;
        }

        const sourceData = sourceDocSnap.data();

        const batch = writeBatch(db);

        // Subtract from source location
        batch.update(sourceDocRef, { quantity: increment(-transferQuantity) });

        // Check if destination location exists
        const destQuery = query(
            collection(db, 'inventory'),
            where('code', '==', sourceData.code),
            where('location', '==', newLocation),
            limit(1)
        );
        const destSnapshot = await getDocs(destQuery);

        if (!destSnapshot.empty) {
            // Add to existing destination
            const destDocRef = destSnapshot.docs[0].ref;
            batch.update(destDocRef, { quantity: increment(transferQuantity) });
        } else {
            // Create new destination record
            const newInventoryRef = doc(collection(db, 'inventory'));
            const newItemData = {
                ...sourceData,
                location: newLocation,
                quantity: transferQuantity,
                createdAt: serverTimestamp()
            };
            batch.set(newInventoryRef, newItemData);
        }

        // Log transaction
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'transfer',
            itemCode: sourceData.code,
            itemName: sourceData.name,
            quantity: transferQuantity,
            unit: sourceData.unit,
            fromLocation: currentLocation,
            toLocation: newLocation,
            note: note,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Chuyển kho thành công!', 'success');

        // Close modal safely
        const modal = document.getElementById('transferModal');
        if (modal) {
            const bsModal = bootstrap.Modal.getInstance(modal);
            if (bsModal) {
                bsModal.hide();
            }
        }

        loadTransferHistory();

    } catch (error) {
        console.error('Error saving transfer:', error);
        showToast('Lỗi nghiêm trọng khi chuyển kho. Vui lòng thử lại.', 'danger');
    }
};


// Load transfer history
async function loadTransferHistory(useFilter = false) {
    try {
        let constraints = [where('type', '==', 'transfer')];

        if (useFilter) {
            const fromDate = document.getElementById('transferFromDate')?.value;
            const toDate = document.getElementById('transferToDate')?.value;

            if (fromDate) {
                const startDate = new Date(fromDate);
                constraints.push(where('timestamp', '>=', startDate));
            }

            if (toDate) {
                const endDate = new Date(toDate);
                endDate.setHours(23, 59, 59, 999);
                constraints.push(where('timestamp', '<=', endDate));
            }
        }

        constraints.push(orderBy('timestamp', 'desc'));

        const transfersQuery = query(collection(db, 'transactions'), ...constraints);
        let snapshot = await getDocs(transfersQuery);

        // Client-side filtering for item code
        let docs = snapshot.docs;
        if (useFilter) {
            const itemCodeFilter = document.getElementById('transferItemCodeFilter')?.value;

            docs = docs.filter(doc => {
                const data = doc.data();
                let match = true;

                if (itemCodeFilter && !data.itemCode?.toLowerCase().includes(itemCodeFilter.toLowerCase())) {
                    match = false;
                }

                return match;
            });
        }

        const content = document.getElementById('transferContent');

        if (docs.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy phiếu chuyển kho nào.</p>';
            return;
        }

        createTransferPagination(docs, content);

    } catch (error) {
        console.error('Error loading transfer history:', error);
        showToast('Lỗi tải lịch sử chuyển kho', 'danger');
    }
}

function initializeDirectAdjustSection() {
    document.getElementById('addAdjustBtn')?.addEventListener('click', showDirectAdjustModal);
    document.getElementById('filterAdjust')?.addEventListener('click', filterDirectAdjustHistory);
    document.getElementById('clearAdjustFilter')?.addEventListener('click', clearDirectAdjustFilter);
}

function filterDirectAdjustHistory() {
    loadDirectAdjustHistory(true);
}

function clearDirectAdjustFilter() {
    document.getElementById('adjustFromDate').value = '';
    document.getElementById('adjustToDate').value = '';
    document.getElementById('adjustItemCodeFilter').value = '';
    loadDirectAdjustHistory();
}

function showDirectAdjustModal() {
    const lastFocusedElement = document.activeElement;
    const modal = createModalSafely(createDirectAdjustModal, 'directAdjustModal');

    if (!modal) return;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        const firstInput = safeGetElement('directAdjustItemCodeInput', 'direct adjust modal');
        if (firstInput) firstInput.focus();
    });

    modal.addEventListener('hidden.bs.modal', () => {
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
        modal.remove();
    });

    bsModal.show();
}

function createDirectAdjustModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'directAdjustModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-cogs"></i> Chỉnh số trực tiếp (Super Admin)
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-danger">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Chỉnh số trực tiếp:</strong> Thao tác này sẽ thực hiện ngay lập tức mà không cần duyệt.
                    </div>
                    
                    <form id="directAdjustForm" onsubmit="return false;">
                        <!-- WORKFLOW INDICATOR -->
                        <div class="request-workflow">
                            <div class="workflow-step active">
                                <div class="workflow-icon">
                                    <i class="fas fa-search"></i>
                                </div>
                                <small>Tìm hàng hóa</small>
                            </div>
                            <div class="workflow-step" id="directSelectStep">
                                <div class="workflow-icon">
                                    <i class="fas fa-mouse-pointer"></i>
                                </div>
                                <small>Chọn vị trí</small>
                            </div>
                            <div class="workflow-step" id="directAdjustStep">
                                <div class="workflow-icon">
                                    <i class="fas fa-cogs"></i>
                                </div>
                                <small>Chỉnh số</small>
                            </div>
                        </div>

                        <!-- BƯỚC 1: TÌM HÀNG HÓA -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-search"></i>
                                Bước 1: Tìm hàng hóa cần chỉnh số
                            </div>
                            <div class="quick-input-row">
                                <div class="input-group-compact">
                                    <div class="lookup-container">
                                        <label class="form-label-compact">
                                            <i class="fas fa-barcode text-danger"></i> Mã hàng cần điều chỉnh *
                                        </label>
                                        <input type="text" class="form-control-compact" id="directAdjustItemCodeInput" 
                                               placeholder="Nhập mã hàng...">
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- BƯỚC 2: CHỌN VỊ TRÍ -->
                        <div class="form-section-compact" id="directAdjustLocationSection" style="display: none;">
                            <div class="form-section-header-compact">
                                <i class="fas fa-mouse-pointer"></i>
                                Bước 2: Chọn vị trí cần điều chỉnh
                            </div>
                            <div id="directAdjustLocationList" class="row">
                                <!-- Location cards will be inserted here -->
                            </div>
                        </div>

                        <!-- BƯỚC 3: THỰC HIỆN CHỈNH SỐ -->
                        <div class="form-section-compact" id="directAdjustDetailsSection" style="display: none;">
                            <div class="form-section-header-compact">
                                <i class="fas fa-cogs"></i>
                                Bước 3: Thực hiện chỉnh số trực tiếp
                            </div>
                            
                            <!-- Adjustment Preview -->
                            <div class="adjustment-preview">
                                <div class="row mb-3">
                                    <div class="col-md-6">
                                        <strong>Sản phẩm:</strong> <span id="directAdjustProductInfo">-</span>
                                    </div>
                                    <div class="col-md-6">
                                        <strong>Vị trí:</strong> <span id="directAdjustLocationInfo">-</span>
                                    </div>
                                </div>
                                
                                <div class="adjustment-cards">
                                    <div class="adjustment-card current">
                                        <h6 class="text-muted">Số lượng hiện tại</h6>
                                        <div class="fs-4 fw-bold" id="directAdjustCurrentQty">0</div>
                                    </div>
                                    <div class="adjustment-card new">
                                        <h6 class="text-muted">Số lượng mới</h6>
                                        <div class="fs-4 fw-bold text-danger" id="directAdjustNewQtyDisplay">0</div>
                                    </div>
                                    <div class="adjustment-card diff" id="directAdjustDiffCard">
                                        <h6 class="text-muted">Chênh lệch</h6>
                                        <div class="fs-4 fw-bold" id="directAdjustDiffDisplay">0</div>
                                    </div>
                                </div>
                            </div>

                            <div class="row">
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-sort-numeric-up text-danger"></i>
                                            Số lượng thực tế (mới) <span class="text-danger">*</span>
                                        </label>
                                        <input type="number" class="form-control-compact" id="directAdjustNewQuantity" 
                                               required min="0" placeholder="0">
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact">
                                            <i class="fas fa-comment text-danger"></i>
                                            Lý do điều chỉnh <span class="text-danger">*</span>
                                        </label>
                                        <input type="text" class="form-control-compact" id="directAdjustReason" 
                                               required placeholder="VD: Kiểm kê thực tế, hàng hỏng...">
                                    </div>
                                </div>
                            </div>
                            <input type="hidden" id="directAdjustInventoryId">
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-danger" id="confirmDirectAdjustBtn" onclick="saveDirectAdjust()" disabled>
                        <i class="fas fa-check"></i> Thực hiện chỉnh số
                    </button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        setupDirectAdjustModalEventListeners();
    }, 0);

    return modal;
}

function setupDirectAdjustModalEventListeners() {
    setTimeout(() => {
        const itemCodeInput = safeGetElement('directAdjustItemCodeInput', 'direct adjust modal setup');
        const newQtyInput = safeGetElement('directAdjustNewQuantity', 'direct adjust modal setup');
        const reasonInput = safeGetElement('directAdjustReason', 'direct adjust modal setup');

        if (itemCodeInput) {
            itemCodeInput.addEventListener('input', debounce(handleDirectAdjustItemCodeInput, 500));
        }

        if (newQtyInput) {
            newQtyInput.addEventListener('input', updateDirectAdjustmentCalculation);
        }

        if (reasonInput) {
            reasonInput.addEventListener('input', updateDirectAdjustmentCalculation);
        }
    }, 100);
}

function updateDirectAdjustmentCalculation() {
    const currentQtyElement = safeGetElement('directAdjustCurrentQty', 'direct adjustment calculation');
    const newQtyInput = safeGetElement('directAdjustNewQuantity', 'direct adjustment calculation');
    const newQtyDisplay = safeGetElement('directAdjustNewQtyDisplay', 'direct adjustment calculation');
    const diffDisplay = safeGetElement('directAdjustDiffDisplay', 'direct adjustment calculation');
    const diffCard = safeGetElement('directAdjustDiffCard', 'direct adjustment calculation');
    const confirmBtn = safeGetElement('confirmDirectAdjustBtn', 'direct adjustment calculation');
    const reasonInput = safeGetElement('directAdjustReason', 'direct adjustment calculation');

    if (!currentQtyElement || !newQtyInput) return;

    const currentQty = parseInt(currentQtyElement.textContent) || 0;
    const newQty = parseInt(newQtyInput.value) || 0;
    const diff = newQty - currentQty;

    if (newQtyDisplay) newQtyDisplay.textContent = newQty;
    if (diffDisplay) diffDisplay.textContent = diff >= 0 ? `+${diff}` : diff;

    if (diffCard) {
        diffCard.className = 'adjustment-card diff';
        if (diff < 0) diffCard.classList.add('negative');
    }

    if (confirmBtn && reasonInput) {
        const hasReason = reasonInput.value.trim();
        const isValidChange = diff !== 0;
        confirmBtn.disabled = !(hasReason && isValidChange);
    }
}

async function handleDirectAdjustItemCodeInput(event) {
    const code = event.target.value.trim().toUpperCase();
    event.target.value = code;

    const locationContainer = document.getElementById('directAdjustLocationSection');
    const locationList = document.getElementById('directAdjustLocationList');
    const detailsContainer = document.getElementById('directAdjustDetailsSection');
    const confirmBtn = document.getElementById('confirmDirectAdjustBtn');

    if (!locationContainer || !locationList || !detailsContainer || !confirmBtn) {
        console.warn('Some direct adjust modal elements not found');
        return;
    }

    locationContainer.style.display = 'none';
    detailsContainer.style.display = 'none';
    locationList.innerHTML = '';
    confirmBtn.disabled = true;

    updateWorkflowStep('directSelectStep', false);
    updateWorkflowStep('directAdjustStep', false);

    if (!code) return;

    try {
        const inventoryQuery = query(
            collection(db, 'inventory'),
            where('code', '==', code)
        );
        const snapshot = await getDocs(inventoryQuery);

        if (snapshot.empty) {
            locationList.innerHTML = '<div class="col-12"><p class="text-danger p-2">Không tìm thấy sản phẩm với mã này.</p></div>';
            locationContainer.style.display = 'block';
        } else {
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const locationCard = createLocationCard(doc.id, data, 'directAdjust');
                locationList.appendChild(locationCard);
            });
            locationContainer.style.display = 'block';
            updateWorkflowStep('directSelectStep', true);
        }
    } catch (error) {
        console.error("Error fetching item for direct adjust:", error);
        showToast('Lỗi khi tìm kiếm mã hàng', 'danger');
    }
}

export function loadAdjustSection() {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền chỉnh số trực tiếp', 'danger');
        return;
    }
    loadDirectAdjustHistory();
    initializeDirectAdjustSection();
}

// Thay thế hàm này trong warehouse.js

export function loadHistorySection() {
    // Hàm này đảm bảo các sự kiện lọc chỉ được gán một lần duy nhất
    const setupHistoryFiltersOnce = () => {
        if (window.historyFiltersInitialized) return; // Nếu đã gán rồi thì thoát

        const getFiltersFromDOM = () => ({
            fromDate: document.getElementById('fromDate').value,
            toDate: document.getElementById('toDate').value,
            filterType: document.getElementById('historyFilter').value,
            itemCodeFilter: document.getElementById('historyItemCodeFilter').value.trim()
        });

        document.getElementById('historyItemCodeFilter')?.addEventListener('input', debounce(() => loadAllHistory(getFiltersFromDOM()), 500));
        
        const changeFilters = ['fromDate', 'toDate', 'historyFilter'];
        changeFilters.forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => loadAllHistory(getFiltersFromDOM()));
        });

        window.historyFiltersInitialized = true; // Đánh dấu đã gán
    };

    setupHistoryFiltersOnce();

    // Lấy trạng thái bộ lọc hiện tại từ giao diện và tải dữ liệu lần đầu
    const currentFilters = {
        fromDate: document.getElementById('fromDate').value,
        toDate: document.getElementById('toDate').value,
        filterType: document.getElementById('historyFilter').value,
        itemCodeFilter: document.getElementById('historyItemCodeFilter').value.trim()
    };
    loadAllHistory(currentFilters);
}

function safeModalOperation(operation, context = 'modal operation') {
    try {
        return operation();
    } catch (error) {
        console.error(`Error in ${context}:`, error);
        showToast(`Lỗi trong ${context}. Vui lòng thử lại.`, 'danger');
        return null;
    }
}

// Wrapper cho việc tạo modal
function createModalSafely(modalCreator, modalId) {
    return safeModalOperation(() => {
        // Remove existing modal if any
        const existingModal = document.getElementById(modalId);
        if (existingModal) {
            existingModal.remove();
        }

        return modalCreator();
    }, `tạo ${modalId}`);
}

function updateAdjustmentCalculation() {
    const currentQtyElement = safeGetElement('adjustCurrentQty', 'adjustment calculation');
    const newQtyInput = safeGetElement('adjustNewQuantity', 'adjustment calculation');
    const newQtyDisplay = safeGetElement('adjustNewQtyDisplay', 'adjustment calculation');
    const diffDisplay = safeGetElement('adjustDiffDisplay', 'adjustment calculation');
    const diffCard = safeGetElement('adjustDiffCard', 'adjustment calculation');
    const confirmBtn = safeGetElement('confirmAdjustBtn', 'adjustment calculation');
    const reasonInput = safeGetElement('adjustReason', 'adjustment calculation');

    if (!currentQtyElement || !newQtyInput) return;

    const currentQty = parseInt(currentQtyElement.textContent) || 0;
    const newQty = parseInt(newQtyInput.value) || 0;
    const diff = newQty - currentQty;

    if (newQtyDisplay) newQtyDisplay.textContent = newQty;
    if (diffDisplay) diffDisplay.textContent = diff >= 0 ? `+${diff}` : diff;

    if (diffCard) {
        diffCard.className = 'adjustment-card diff';
        if (diff < 0) diffCard.classList.add('negative');
    }

    // Update button state
    if (confirmBtn && reasonInput) {
        const hasReason = reasonInput.value.trim();
        const isValidChange = diff !== 0;
        confirmBtn.disabled = !(hasReason && isValidChange);
    }
}

function updateWorkflowStep(stepId, isActive) {
    const step = document.getElementById(stepId);
    if (step) {
        if (isActive) {
            step.classList.add('active');
        } else {
            step.classList.remove('active');
        }
    }
}

function safeGetElement(id, context = 'general') {
    const element = document.getElementById(id);
    if (!element) {
        console.warn(`⚠️ Element missing: '${id}' in context: ${context}`);
        // Log all available elements for debugging
        if (context.includes('modal')) {
            const modalElements = Array.from(document.querySelectorAll('[id]')).map(el => el.id);
            console.log('Available modal elements:', modalElements.filter(id => id.includes('request') || id.includes('adjust')));
        }
    }
    return element;
}

function validateModalState(modalId, requiredElements) {
    const modal = document.getElementById(modalId);
    if (!modal) {
        console.error(`Modal ${modalId} not found`);
        return false;
    }

    const missingElements = requiredElements.filter(id => !document.getElementById(id));
    if (missingElements.length > 0) {
        console.error(`Missing elements in ${modalId}:`, missingElements);
        return false;
    }

    return true;
}

function validateAdjustRequestModal() {
    return validateModalState('adjustRequestModal', [
        'requestInventoryId',
        'requestCurrentQty',
        'requestNewQuantity',
        'requestReason'
    ]);
}

function validateAdjustModal() {
    return validateModalState('adjustModal', [
        'adjustInventoryId',
        'adjustCurrentQty',
        'adjustNewQuantity',
        'adjustReason'
    ]);
}

// Global error handler for modal operations
window.addEventListener('error', function (e) {
    if (e.error && e.error.message && e.error.message.includes('Cannot read properties of null')) {
        console.error('Null reference error caught:', e.error);
        showToast('Đã xảy ra lỗi giao diện. Vui lòng đóng modal và thử lại.', 'warning');
        e.preventDefault();
    }
});

function fillAdjustmentDetails(docId, data) {
    const detailsContainer = document.getElementById('adjustmentDetailsContainer');
    const confirmBtn = document.getElementById('confirmAdjustBtn');

    document.getElementById('adjustItemName').value = data.name;
    document.getElementById('selectedLocation').value = data.location;
    document.getElementById('currentQuantity').value = data.quantity;
    document.getElementById('newQuantity').value = data.quantity; // Gợi ý số lượng
    document.getElementById('adjustInventoryId').value = docId; // Lưu ID quan trọng này

    detailsContainer.style.display = 'block'; // Hiển thị form chi tiết
    confirmBtn.disabled = false; // Bật nút xác nhận
    document.getElementById('newQuantity').focus();
    document.getElementById('newQuantity').select();
}

async function loadInventoryForAdjust() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'), orderBy('name'));
        const snapshot = await getDocs(inventoryQuery);

        const select = document.getElementById('adjustInventorySelect');
        select.innerHTML = '<option value="">-- Chọn mặt hàng --</option>';

        snapshot.forEach(doc => {
            const data = doc.data();
            const option = document.createElement('option');
            option.value = doc.id;
            option.textContent = `${data.code} - ${data.name}`;
            option.dataset.quantity = data.quantity;
            select.appendChild(option);
        });

        select.addEventListener('change', function () {
            const selectedOption = this.options[this.selectedIndex];
            document.getElementById('currentQuantity').value = selectedOption.dataset.quantity || '';
        });

    } catch (error) {
        console.error('Error loading inventory for adjust:', error);
        showToast('Lỗi tải danh sách tồn kho', 'danger');
    }
}



function createHistoryPagination(allData, container) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    async function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        // --- BƯỚC 1: LÀM GIÀU DỮ LIỆU ---
        // Biến enrichedPageData được định nghĩa ở đây và sẽ có sẵn cho toàn bộ hàm renderPage
        const enrichedPageData = await Promise.all(pageData.map(async (docSnapshot) => {
            const data = docSnapshot.data();
            let originalTransactionNumber = null;

            if (data.type === 'import_edited' || data.type === 'export_edited') {
                try {
                    const originalDocRef = doc(db, 'transactions', data.originalTransactionId);
                    const originalDocSnap = await getDoc(originalDocRef);
                    if (originalDocSnap.exists()) {
                        const originalData = originalDocSnap.data();
                        originalTransactionNumber = originalData.importNumber || originalData.exportNumber || 'N/A';
                    } else {
                        originalTransactionNumber = 'Không tìm thấy';
                    }
                } catch (error) {
                    console.error(`Lỗi khi lấy giao dịch gốc ${data.originalTransactionId}:`, error);
                    originalTransactionNumber = 'Lỗi';
                }
            }
            
            return {
                id: docSnapshot.id,
                data: { ...data, originalTransactionNumber: originalTransactionNumber }
            };
        }));

        // --- BƯỚC 2: HIỂN THỊ DỮ LIỆU ĐÃ ĐƯỢC LÀM GIÀU ---
        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    <th style="text-align: center;">Loại</th>
                    <th style="text-align: center;">Chi tiết</th>
                    <th style="text-align: center;">Người thực hiện</th>
                    <th style="text-align: center;">Thời gian</th>
                    <th style="text-align: center;">Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        // Vòng lặp bây giờ sử dụng biến enrichedPageData đã được định nghĩa và chờ ở trên
        enrichedPageData.forEach(item => {
            const docId = item.id;
            const data = item.data;
            const row = document.createElement('tr');
            const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
            let performedBy = data.performedByName || data.modifiedByName || data.deletedByName || 'N/A';

            const typeConfig = {
            'import': { label: 'Nhập kho', badgeClass: 'bg-success', icon: 'fas fa-download' },
            'import_edited': { label: 'Sửa Nhập', badgeClass: 'bg-warning text-dark', icon: 'fas fa-pencil-alt' },
            'import_deleted': { label: 'Xóa Nhập', badgeClass: 'bg-danger', icon: 'fas fa-trash-alt' },

            'export': { label: 'Xuất kho', badgeClass: 'bg-warning text-dark', icon: 'fas fa-upload' },
            'export_edited': { label: 'Sửa Xuất', badgeClass: 'bg-warning text-dark', icon: 'fas fa-pencil-alt' },
            'export_deleted': { label: 'Xóa Xuất', badgeClass: 'bg-danger', icon: 'fas fa-trash-alt' },
            
            'transfer': { label: 'Chuyển kho', badgeClass: 'bg-info', icon: 'fas fa-exchange-alt' },
            'transfer_edited': { label: 'Sửa Chuyển', badgeClass: 'bg-warning text-dark', icon: 'fas fa-pencil-alt' },
            'transfer_deleted': { label: 'Xóa Chuyển', badgeClass: 'bg-danger', icon: 'fas fa-trash-alt' },

            'adjust': { label: 'Chỉnh số', badgeClass: 'bg-secondary', icon: 'fas fa-edit' },
            'adjust_edited': { label: 'Sửa Chỉnh số', badgeClass: 'bg-warning text-dark', icon: 'fas fa-pencil-alt' },
            'adjust_deleted': { label: 'Xóa Chỉnh số', badgeClass: 'bg-danger', icon: 'fas fa-trash-alt' },
            'adjust_rejected': { label: 'Từ chối CS', badgeClass: 'bg-secondary', icon: 'fas fa-times-circle' },

            'user_approval': { label: 'Duyệt User', badgeClass: 'bg-primary', icon: 'fas fa-user-check' },
            'user_management': { label: 'Quản lý User', badgeClass: 'bg-primary', icon: 'fas fa-users-cog' },

            'inventory_edited': { label: 'Sửa Mã hàng', badgeClass: 'bg-warning text-dark', icon: 'fas fa-pencil-alt' },
            'inventory_archived': { label: 'Xóa Mã hàng', badgeClass: 'bg-danger', icon: 'fas fa-archive' },
        };
            const config = typeConfig[data.type] || { label: data.type, badgeClass: 'bg-dark', icon: 'fas fa-question' };

            let details = '';
            let viewButton = '';

            switch (data.type) {
                case 'import':
                    details = `Phiếu: ${data.importNumber || 'N/A'} (${data.supplier || 'N/A'})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewImportDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'export':
                    details = `Phiếu: ${data.exportNumber || 'N/A'} (${data.recipient || 'N/A'})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewExportDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'transfer':
                    details = `Chuyển ${data.quantity || 0} ${data.unit || ''} ${data.itemCode || 'N/A'} (${data.fromLocation || 'N/A'} → ${data.toLocation || 'N/A'})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewTransferDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'adjust':
                    details = `
                        <div class="d-flex align-items-center">
                            <span>Điều chỉnh ${data.itemCode || 'N/A'} (${data.previousQuantity || 0} → ${data.newQuantity || 0})</span>
                           
                        </div>
                    `;

                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewAdjustDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'adjust_deleted':
                    details = `Xóa chỉnh số ${data.deletedItemCode || 'N/A'} (đã khôi phục về ${data.revertedTo || 'N/A'})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewAdjustDeletionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'adjust_rejected':
                    details = `
                        <div class="d-flex align-items-center">                           
                            <span>Từ chối ${data.itemCode || 'N/A'} (${data.currentQuantity || 0} → ${data.requestedQuantity || 0})</span>                          
                        </div>
                    `;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewAdjustRejectionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'user_approval':
                    let userInfo = data.userName || data.userEmail || 'User không xác định';
                    const actionText = data.action === 'approved' ? 'Phê duyệt' : 'Từ chối';
                    details = `${actionText} user (${userInfo})`;

                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewUserApprovalDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'user_management':
                    details = `Cập nhật user: ${data.userName || data.userEmail || 'N/A'}`;

                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewUserManagementDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'import_deleted':
                    details = `Xóa phiếu nhập: ${data.deletedImportNumber || 'N/A'}`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewImportDeletionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'export_deleted':
                    details = `Xóa phiếu xuất: ${data.deletedExportNumber || 'N/A'}`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewExportDeletionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'transfer_deleted':
                    details = `Xóa chuyển kho: ${data.deletedItemCode || 'N/A'} (${data.deletedQuantity || 0})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewTransferDeletionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;
                case 'import_edited':
                    details = `Sửa phiếu nhập kho số phiếu (${data.originalTransactionNumber || 'N/A'})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewEditDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
                    break;
                case 'export_edited':
                    details = `Sửa phiếu xuất kho số phiếu (${data.originalTransactionNumber || 'N/A'})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewEditDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
                    break;
                case 'adjust_edited':
                    details = `Sửa phiếu chỉnh số ${data.itemCode}`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewEditDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
                    break;
                case 'transfer_edited':
                    details = `Sửa phiếu chuyển kho ${data.itemCode}`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewEditDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
                    break;
                case 'inventory_edited':
                    details = `Sửa mã hàng ${data.itemCode}`;
                    // Chúng ta sẽ cần tạo hàm xem chi tiết này
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewEditDetails('${docId}')"><i class="fas fa-eye"></i>Xem</button>`;
                    break;
                case 'inventory_archived':
                    details = `Xóa mã hàng: ${data.itemCode}`;
                     // Chúng ta sẽ cần tạo hàm xem chi tiết này
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewDeletionDetails('${docId}')"><i class="fas fa-eye"></i>Xem</button>`;
                    break;

                default:
                    details = `${data.type || 'N/A'}`;
                    viewButton = '<span class="text-muted">-</span>';
            }

            row.innerHTML = `
                <td>
                    <span class="badge ${config.badgeClass}">
                        <i class="${config.icon}"></i> ${config.label}
                    </span>
                </td>
                <td class="details-column">${details}</td>
                <td>${performedBy}</td>
                <td>${date}</td>
                <td>${viewButton}</td>
            `;

            tbody.appendChild(row);
        });

        // Create pagination
        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="History pagination"><ul class="pagination pagination-sm mb-0" id="historyPagination"></ul></nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);
        await forceUIRefresh();
        updatePaginationControls(page, totalPages, 'historyPagination', renderPage);
    }

    renderPage(1);
}

window.viewDeletionDetails = async function(transactionId) {
    try {
        const transSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!transSnap.exists()) {
            return showToast('Không tìm thấy lịch sử hành động xóa.', 'danger');
        }

        const data = transSnap.data();
        const modal = createDeletionDetailsModal(data); // Gọi hàm tạo modal chung
        
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => modal.remove());

    } catch (error) {
        console.error("Lỗi khi xem chi tiết xóa:", error);
        showToast("Đã xảy ra lỗi khi xem chi tiết.", 'danger');
    }
}
// THÊM VÀO CUỐI FILE WAREHOUSE.JS

window.viewEditDetails = async function(transactionId) {
    try {
        const transSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!transSnap.exists()) {
            return showToast('Không tìm thấy lịch sử hành động sửa đổi.', 'danger');
        }

        const data = transSnap.data();
        const modal = createEditDetailsModal(data); // Gọi hàm tạo modal chung
        
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => modal.remove());

    } catch (error) {
        console.error("Lỗi khi xem chi tiết sửa đổi:", error);
        showToast("Đã xảy ra lỗi khi xem chi tiết.", 'danger');
    }
}

// THAY THẾ TOÀN BỘ HÀM NÀY BẰNG PHIÊN BẢN MỚI

/**
 * Tạo HTML cho modal hiển thị chi tiết một hành động XÓA, theo một mẫu giao diện chung.
 * @param {object} data - Dữ liệu từ log transaction.
 * @returns {HTMLElement} - Phần tử DOM của modal.
 */
function createDeletionDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    
    // --- Logic thông minh để chuẩn bị nội dung động ---
    let modalTitle = 'Chi tiết Hành động Xóa';
    let alertMainText = 'Một mục đã được xóa';
    let alertSubText = 'Các thay đổi liên quan đã được hoàn tác khỏi hệ thống.';
    let generalInfoHtml = '';
    let detailsTitle = 'Thông tin chi tiết';
    let detailsContentHtml = '';
    let reasonHtml = '';
    let impactHtml = '';

    switch(data.type) {
        case 'adjust_deleted':
            modalTitle = 'Chi tiết Xóa Phiếu Chỉnh Số';
            alertMainText = 'Phiếu chỉnh số đã bị xóa';
            alertSubText = 'Tồn kho đã được khôi phục về số lượng ban đầu.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Mã hàng:</strong> ${data.deletedItemCode}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
                <div class="col-md-6"><strong>Thời gian xóa:</strong> ${date}</div>
            `;
            detailsTitle = 'Thông tin phiếu chỉnh số đã hủy';
            detailsContentHtml = `
                <div class="row text-center">
                    <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Số lượng ban đầu</h6><p class="card-text fs-4">${data.deletedPreviousQuantity}</p><small class="text-success">✓ Đã khôi phục</small></div></div></div>
                    <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Số lượng đã chỉnh</h6><p class="card-text fs-4 text-muted"><s>${data.deletedNewQuantity}</s></p><small class="text-danger">✗ Đã hủy</small></div></div></div>
                    <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Chênh lệch</h6><p class="card-text fs-4 text-muted"><s>${data.deletedAdjustment >= 0 ? '+' : ''}${data.deletedAdjustment}</s></p><small class="text-danger">✗ Đã hủy</small></div></div></div>
                </div>`;
            reasonHtml = `<p class="ms-2 mt-1 mb-0 fst-italic bg-light p-2 rounded">${data.deletedReason}</p>`;
            impactHtml = `<strong>Tác động:</strong> Tồn kho đã được khôi phục về ${data.revertedTo}.`;
            break;
        
        case 'import_deleted':
        case 'export_deleted':
            const isImport = data.type === 'import_deleted';
            const deletedItems = data.deletedItems || [];
            modalTitle = isImport ? 'Chi tiết Xóa Phiếu Nhập' : 'Chi tiết Xóa Phiếu Xuất';
            alertMainText = isImport ? 'Phiếu nhập đã bị xóa' : 'Phiếu xuất đã bị xóa';
            alertSubText = 'Số lượng hàng hóa trong phiếu đã được hoàn lại vào tồn kho.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Số phiếu đã xóa:</strong> ${data.deletedImportNumber || data.deletedExportNumber}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
                <div class="col-md-6"><strong>Thời gian xóa:</strong> ${date}</div>
            `;
            detailsTitle = 'Các mặt hàng đã được hoàn lại vào tồn kho';
            detailsContentHtml = `
                <div class="table-responsive" style="max-height: 200px;">
                    <table class="table table-sm table-bordered">
                        <thead class="table-light"><tr><th>Mã hàng</th><th>Tên</th><th>Số lượng hoàn lại</th></tr></thead>
                        <tbody>
                            ${deletedItems.map(item => `<tr><td>${item.code}</td><td>${item.name}</td><td class="text-success fw-bold">+${item.quantity}</td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
            impactHtml = `<strong>Tác động:</strong> Toàn bộ số lượng từ phiếu này đã được hoàn lại vào tồn kho hệ thống.`;
            break;
            
        case 'inventory_archived':
            modalTitle = 'Chi tiết Xóa (Lưu trữ) Sản phẩm';
            alertMainText = 'Sản phẩm đã được lưu trữ';
            alertSubText = 'Sản phẩm này đã bị ẩn khỏi các danh sách và tìm kiếm thông thường.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Mã sản phẩm:</strong> ${data.itemCode}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
                <div class="col-md-6"><strong>Thời gian xóa:</strong> ${date}</div>
            `;
            detailsTitle = 'Thông tin chi tiết';
            detailsContentHtml = `<p class="p-3 bg-light rounded border">${data.details}</p>`;
            impactHtml = '<strong>Tác động:</strong> Sản phẩm này không còn hiển thị trong danh sách tồn kho chính.';
            break;
    }

    // --- Xây dựng HTML cuối cùng từ các mảnh đã chuẩn bị ---
    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title"><i class="fas fa-trash-alt"></i> ${modalTitle}</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- CẢNH BÁO -->
                    <div class="alert alert-danger d-flex align-items-center mb-4">
                        <i class="fas fa-trash-alt fa-2x me-3"></i>
                        <div><strong>${alertMainText}</strong><br><small>${alertSubText}</small></div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        ${generalInfoHtml}
                        <div class="col-md-6"><strong>Trạng thái:</strong> 
                            <span class="badge bg-danger"><i class="fas fa-trash-alt"></i> Đã xóa</span>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHI TIẾT ĐỘNG -->
                    <h6 class="text-muted mb-3"><i class="fas fa-history me-2"></i>${detailsTitle}</h6>
                    <div class="mb-4">${detailsContentHtml}</div>

                    <!-- LÝ DO (NẾU CÓ) -->
                    ${reasonHtml ? `
                        <div class="mb-3">
                            <strong>Lý do ban đầu:</strong>
                            ${reasonHtml}
                        </div>` : ''
                    }

                    <!-- THÔNG TIN TÁC ĐỘNG -->
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        ${impactHtml}
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

function createEditDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    
    // --- BỘ DỊCH TÊN TRƯỜNG THÔNG TIN (Rất quan trọng) ---
    const fieldNames = {
        importNumber: 'Số phiếu nhập',
        supplier: 'Nhà cung cấp',
        exportNumber: 'Số phiếu xuất',
        recipient: 'Người nhận',
        items_changed: 'Số lượng mặt hàng',
        name: 'Tên mô tả',
        unit: 'Đơn vị tính',
        category: 'Danh mục',
        location: 'Vị trí',
        quantity: 'Số lượng',
        note: 'Ghi chú'
    };
    
    // --- Logic thông minh để xây dựng nội dung ---
    let modalTitle = 'Chi tiết Sửa đổi Giao dịch';
    const transactionType = data.type.replace('_edited', '').toUpperCase();
    let mainInfoHtml = '';
    let changesHtml = '';

    // Xây dựng bảng chi tiết các thay đổi
    if (data.changes && Object.keys(data.changes).length > 0) {
        for (const [key, value] of Object.entries(data.changes)) {
            const fieldName = fieldNames[key] || key; // Lấy tên Tiếng Việt hoặc giữ nguyên tên kỹ thuật
            changesHtml += `
                <tr>
                    <td>${fieldName}</td>
                    <td><span class="text-muted">${value.from}</span></td>
                    <td><i class="fas fa-arrow-right text-primary mx-2"></i></td>
                    <td><strong class="text-success">${value.to}</strong></td>
                </tr>`;
        }
    } else {
        changesHtml = '<tr><td colspan="4" class="text-center text-muted">Không có thông tin thay đổi chi tiết.</td></tr>';
    }

    // Xây dựng thông tin chính
    mainInfoHtml = `
        <div class="col-md-6"><strong>Loại giao dịch:</strong> ${transactionType}</div>
        <div class="col-md-6"><strong>Người thực hiện:</strong> ${data.performedByName}</div>
        <div class="col-md-6"><strong>Đối tượng:</strong> ${data.itemCode || data.originalTransactionNumber || 'N/A'}</div>
        <div class="col-md-6"><strong>Thời gian:</strong> ${date}</div>
    `;

    // --- Xây dựng HTML cuối cùng ---
    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-warning text-dark">
                    <h5 class="modal-title"><i class="fas fa-pencil-alt"></i> ${modalTitle}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- CẢNH BÁO -->
                    <div class="alert alert-warning d-flex align-items-center mb-4">
                        <i class="fas fa-pencil-alt fa-2x me-3"></i>
                        <div>
                            <strong>Một giao dịch đã được sửa đổi</strong><br>
                            <small>Các thay đổi đã được áp dụng và ghi lại vào hệ thống.</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        ${mainInfoHtml}
                    </div>

                    <!-- THÔNG TIN THAY ĐỔI -->
                    <h6 class="text-muted mb-3"><i class="fas fa-exchange-alt me-2"></i>Chi tiết các thay đổi</h6>
                    <div class="table-responsive">
                        <table class="table table-bordered">
                            <thead class="table-light">
                                <tr>
                                    <th>Trường thông tin</th>
                                    <th>Giá trị cũ</th>
                                    <th></th>
                                    <th>Giá trị mới</th>
                                </tr>
                            </thead>
                            <tbody>${changesHtml}</tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                    ${data.originalTransactionId ? `<button type="button" class="btn btn-primary" onclick="viewOriginalTransaction('${data.originalTransactionId}', '${data.type}')">Xem phiếu gốc</button>` : ''}
                </div>
            </div>
        </div>
    `;

    return modal;
}

window.viewOriginalTransaction = function(transactionId, type) {
    // Đóng modal hiện tại trước khi mở modal mới
    const currentModal = document.getElementById('editDetailsModal');
    if (currentModal) {
        bootstrap.Modal.getInstance(currentModal).hide();
    }
    
    // Gọi hàm xem chi tiết tương ứng
    if (type.includes('import')) viewImportDetails(transactionId);
    else if (type.includes('export')) viewExportDetails(transactionId);
    else if (type.includes('adjust')) viewAdjustDetails(transactionId);
    else if (type.includes('transfer')) viewTransferDetails(transactionId);
}

window.viewAdjustDeletionDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy thông tin xóa chỉnh số', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createAdjustDeletionDetailsModal(data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading adjust deletion details:', error);
        showToast('Lỗi tải chi tiết xóa chỉnh số', 'danger');
    }
};

function createAdjustDeletionDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-trash-alt"></i> Chi tiết xóa phiếu chỉnh số
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- CẢNH BÁO -->
                    <div class="alert alert-danger d-flex align-items-center mb-4">
                        <i class="fas fa-trash-alt fa-2x me-3"></i>
                        <div>
                            <strong>Phiếu chỉnh số đã bị xóa</strong><br>
                            <small>Tồn kho đã được khôi phục về số lượng ban đầu</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-md-6"><strong>Mã hàng:</strong> ${data.deletedItemCode}</div>
                        <div class="col-md-6"><strong>Người xóa:</strong> ${data.deletedByName}</div>
                        <div class="col-md-6"><strong>Thời gian xóa:</strong> ${date}</div>
                        <div class="col-md-6"><strong>Trạng thái:</strong> 
                            <span class="badge bg-danger">
                                <i class="fas fa-trash-alt"></i> Đã xóa
                            </span>
                        </div>
                    </div>

                    <!-- THÔNG TIN PHIẾU CHỈNH SỐ ĐÃ XÓA -->
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-history me-2"></i>Thông tin phiếu chỉnh số đã xóa
                    </h6>
                    <div class="row text-center mb-4">
                        <div class="col-4">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Số lượng ban đầu</h6>
                                    <p class="card-text fs-4">${data.deletedPreviousQuantity}</p>
                                    <small class="text-success">✓ Đã khôi phục</small>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Số lượng đã chỉnh</h6>
                                    <p class="card-text fs-4 text-muted"><s>${data.deletedNewQuantity}</s></p>
                                    <small class="text-danger">✗ Đã hủy</small>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Chênh lệch đã hủy</h6>
                                    <p class="card-text fs-4 text-muted">
                                        <s>${data.deletedAdjustment >= 0 ? '+' : ''}${data.deletedAdjustment}</s>
                                    </p>
                                    <small class="text-danger">✗ Không áp dụng</small>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- LÝ DO CHỈNH SỐ BAN ĐẦU -->
                    <div class="mb-3">
                        <strong>Lý do chỉnh số ban đầu:</strong>
                        <p class="ms-2 mt-1 mb-0 fst-italic bg-light p-2 rounded">${data.deletedReason}</p>
                    </div>

                    <!-- THÔNG TIN TÁC ĐỘNG -->
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> Tồn kho đã được khôi phục về ${data.revertedTo}. 
                        Phiếu chỉnh số này đã bị xóa hoàn toàn khỏi hệ thống.
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

window.viewAdjustRejectionDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy thông tin từ chối', 'danger');
            return;
        }

        const data = docSnap.data();

        // Chuyển đổi dữ liệu transaction thành format giống adjust request
        const adjustRequestData = {
            itemCode: data.itemCode,
            itemName: data.itemName,
            location: data.location,
            currentQuantity: data.currentQuantity,
            requestedQuantity: data.requestedQuantity,
            adjustment: data.adjustment,
            reason: data.reason,
            status: 'rejected',
            requestedByName: data.requestedByName,
            rejectedByName: data.performedByName,
            rejectedDate: data.timestamp,
            rejectionReason: data.rejectionReason,
            requestDate: data.requestDate,
            timestamp: data.timestamp
        };

        const modal = createAdjustRequestDetailsModal(adjustRequestData);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading rejection details:', error);
        showToast('Lỗi tải chi tiết từ chối', 'danger');
    }
};

window.viewUserManagementDetails = async function (transactionId) {
    try {
        const transSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!transSnap.exists()) {
            showToast('Không tìm thấy giao dịch', 'danger');
            return;
        }

        const transData = transSnap.data();

        // Tạo modal để hiển thị chi tiết thay đổi user
        const modal = createUserManagementDetailsModal(transData);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => modal.remove());

    } catch (error) {
        console.error("Error viewing user management details", error);
        showToast('Lỗi xem chi tiết', 'danger');
    }
}

// Thêm function mới để tạo modal chi tiết user management
function createUserManagementDetailsModal(transData) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'userManagementDetailsModal';
    modal.setAttribute('tabindex', '-1');

    // Chuẩn bị thông tin thay đổi
    let changesInfo = '';
    if (transData.changes) {
        for (const [field, change] of Object.entries(transData.changes)) {
            const fieldNames = {
                'name': 'Họ tên',
                'role': 'Vai trò',
                'status': 'Trạng thái'
            };
            const fieldName = fieldNames[field] || field;

            changesInfo += `
                <tr>
                    <td><strong>${fieldName}</strong></td>
                    <td><span class="text-muted">${change.from}</span></td>
                    <td><i class="fas fa-arrow-right text-primary"></i></td>
                    <td><span class="text-success fw-bold">${change.to}</span></td>
                </tr>
            `;
        }
    }

    const date = transData.timestamp ?
        transData.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-users-cog"></i> Chi tiết thay đổi thông tin User
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- THÔNG BÁO THÀNH CÔNG -->
                    <div class="alert alert-info d-flex align-items-center mb-4">
                        <i class="fas fa-check-circle fa-2x me-3"></i>
                        <div>
                            <strong>Cập nhật thông tin user thành công</strong><br>
                            <small>Các thay đổi đã được áp dụng cho tài khoản người dùng</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-12 mb-2">
                            <span class="badge bg-primary">
                                <i class="fas fa-users-cog"></i> Cập nhật thông tin User
                            </span>
                        </div>
                        <div class="col-md-6"><strong>Tên người dùng:</strong> ${transData.userName || 'N/A'}</div>
                        <div class="col-md-6"><strong>Email:</strong> ${transData.userEmail || 'N/A'}</div>
                        <div class="col-md-6"><strong>Người thực hiện:</strong> ${transData.performedByName}</div>
                        <div class="col-md-6"><strong>Thời gian:</strong> ${date}</div>
                    </div>

                    <!-- CHI TIẾT THAY ĐỔI -->
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-exchange-alt me-2"></i>Chi tiết thay đổi
                    </h6>
                    ${changesInfo ? `
                        <div class="table-responsive">
                            <table class="table table-bordered">
                                <thead class="table-light">
                                    <tr>
                                        <th>Trường thông tin</th>
                                        <th>Giá trị cũ</th>
                                        <th></th>
                                        <th>Giá trị mới</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${changesInfo}
                                </tbody>
                            </table>
                        </div>
                    ` : `
                        <div class="alert alert-warning">
                            <i class="fas fa-exclamation-triangle"></i>
                            Không có thông tin chi tiết về thay đổi.
                        </div>
                    `}

                    <!-- THÔNG TIN TÁC ĐỘNG -->
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> Thông tin tài khoản của người dùng ${transData.userName || transData.userEmail} đã được cập nhật theo các thay đổi trên.
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}


function createAdjustRejectionDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const rejectionDate = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const requestDate = data.requestDate ? data.requestDate.toDate().toLocaleString('vi-VN') : 'N/A';
    const adjustment = data.adjustment || 0;
    const adjustmentClass = adjustment > 0 ? 'text-success' : adjustment < 0 ? 'text-danger' : '';
    const adjustmentSymbol = adjustment > 0 ? '+' : '';

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-times-circle"></i> Chi tiết từ chối yêu cầu chỉnh số
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- CẢNH BÁO -->
                    <div class="alert alert-danger d-flex align-items-center mb-4">
                        <i class="fas fa-exclamation-triangle fa-2x me-3"></i>
                        <div>
                            <strong>Yêu cầu đã bị từ chối</strong><br>
                            <small>Không có thay đổi nào được thực hiện trên tồn kho</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-md-6"><strong>Mã hàng:</strong> ${data.itemCode}</div>
                        <div class="col-md-6"><strong>Tên mô tả:</strong> ${data.itemName}</div>
                        <div class="col-md-6"><strong>Vị trí:</strong> ${data.location}</div>
                        <div class="col-md-6"><strong>Trạng thái:</strong> 
                            <span class="badge bg-danger">
                                <i class="fas fa-times-circle"></i> Đã từ chối
                            </span>
                        </div>
                        <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
                        <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
                        <div class="col-md-6"><strong>Người từ chối:</strong> ${data.performedByName}</div>
                        <div class="col-md-6"><strong>Ngày từ chối:</strong> ${rejectionDate}</div>
                    </div>

                    <!-- THÔNG TIN THAY ĐỔI ĐỀ XUẤT (KHÔNG THỰC HIỆN) -->
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-ban me-2"></i>Thay đổi đề xuất (không được thực hiện)
                    </h6>
                    <div class="row text-center mb-4">
                        <div class="col-4">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Số lượng hiện tại</h6>
                                    <p class="card-text fs-4">${data.currentQuantity}</p>
                                    <small class="text-success">✓ Giữ nguyên</small>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Số lượng đề xuất</h6>
                                    <p class="card-text fs-4 text-muted"><s>${data.requestedQuantity}</s></p>
                                    <small class="text-danger">✗ Không thực hiện</small>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Chênh lệch đề xuất</h6>
                                    <p class="card-text fs-4 text-muted"><s class="${adjustmentClass}">${adjustmentSymbol}${adjustment}</s></p>
                                    <small class="text-danger">✗ Không áp dụng</small>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- LÝ DO YÊU CẦU -->
                    <div class="mb-3">
                        <strong>Lý do yêu cầu chỉnh số ban đầu:</strong>
                        <p class="ms-2 mt-1 mb-0 fst-italic bg-light p-2 rounded">${data.reason}</p>
                    </div>

                    <!-- LÝ DO TỪ CHỐI -->
                    <div class="mb-3">
                        <strong class="text-danger">Lý do từ chối:</strong>
                        <p class="ms-2 mt-1 mb-0 fst-italic bg-danger bg-opacity-10 p-2 rounded text-danger border border-danger">
                            <i class="fas fa-exclamation-circle me-1"></i>${data.rejectionReason}
                        </p>
                    </div>

                    <!-- THÔNG TIN TÁC ĐỘNG -->
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> Không có thay đổi nào được thực hiện trên hệ thống tồn kho. 
                        Số lượng tại vị trí "${data.location}" vẫn giữ nguyên là ${data.currentQuantity}.
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

// Thay thế hàm này trong warehouse.js

async function loadAllHistory(filters = {}) {
    try {
        const fromDate = filters.fromDate;
        const toDate = filters.toDate;
        const filterType = filters.filterType || 'all';
        const itemCodeFilter = (filters.itemCodeFilter || '').trim().toLowerCase();

        const transactionTypeMap = {
            'import': ['import', 'import_edited', 'import_deleted'],
            'export': ['export', 'export_edited', 'export_deleted'],
            'transfer': ['transfer', 'transfer_edited', 'transfer_deleted'],
            'adjust': ['adjust', 'adjust_edited', 'adjust_deleted', 'adjust_rejected'],
            'user_management': ['user_approval', 'user_management'] 
        };

        let historyQuery = collection(db, 'transactions');
        const constraints = [];

        // Lọc theo loại giao dịch (trên server)
        if (filterType !== 'all' && transactionTypeMap[filterType]) {
            constraints.push(where('type', 'in', transactionTypeMap[filterType]));
        }

        // Lọc theo ngày (trên server)
        if (fromDate) {
            constraints.push(where('timestamp', '>=', new Date(fromDate)));
        }
        if (toDate) {
            const endDate = new Date(toDate);
            endDate.setHours(23, 59, 59, 999);
            constraints.push(where('timestamp', '<=', endDate));
        }

        constraints.push(orderBy('timestamp', 'desc'));

        if (constraints.length > 0) {
            historyQuery = query(historyQuery, ...constraints);
        }

        const snapshot = await getDocs(historyQuery);
        let docs = snapshot.docs;

        // Lọc theo mã hàng (trên client sau khi đã lấy dữ liệu)
        if (itemCodeFilter) {
            docs = docs.filter(doc => {
                const data = doc.data();
                const codeToCheck = [
                    data.itemCode,
                    data.deletedItemCode
                ].filter(Boolean).map(c => c.toLowerCase());

                if (codeToCheck.some(c => c.includes(itemCodeFilter))) {
                    return true;
                }

                if (data.items && Array.isArray(data.items)) {
                    return data.items.some(item => item.code && item.code.toLowerCase().includes(itemCodeFilter));
                }

                if (data.deletedItems && Array.isArray(data.deletedItems)) {
                    return data.deletedItems.some(item => item.code && item.code.toLowerCase().includes(itemCodeFilter));
                }
                return false;
            });
        }

        const content = document.getElementById('historyContent');
        if (!content) return;

        if (docs.length === 0) {
            content.innerHTML = '<p class="text-muted">Không có dữ liệu phù hợp.</p>';
            return;
        }

        createHistoryPagination(docs, content);

    } catch (error) {
        console.error('Lỗi tải lịch sử giao dịch:', error);
        showToast('Lỗi tải lịch sử giao dịch', 'danger');
    }
}


// Initialize all functions
document.addEventListener('DOMContentLoaded', function () {
    // Set today's date for history filters
    const today = new Date().toISOString().split('T')[0];
    if (document.getElementById('toDate')) {
        document.getElementById('toDate').value = today;
    }
});

// Function chung để tạo pagination cho bất kỳ section nào
function createGenericPagination(allData, container, tableConfig, paginationId) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        // Create table
        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    ${tableConfig.headers.map(header => `<th>${header}</th>`).join('')}
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');

        pageData.forEach(doc => {
            const row = document.createElement('tr');
            row.innerHTML = tableConfig.renderRow(doc);
            tbody.appendChild(row);
        });

        // Create pagination
        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="${tableConfig.label} pagination">
                <ul class="pagination pagination-sm mb-0" id="${paginationId}">
                </ul>
            </nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);

        updatePaginationControls(page, totalPages, paginationId, renderPage);
    }

    renderPage(1);
}

function initializeFilters() {
    // Hàm trợ giúp để thiết lập bộ lọc trực tiếp cho một khu vực
    const setupLiveFilter = (config) => {
        // Các ô nhập văn bản để tìm kiếm trực tiếp với debounce
        config.textInputs?.forEach(id => {
            document.getElementById(id)?.addEventListener('input', debounce(() => config.loader(true), 500));
        });
        // Các ô lựa chọn và ngày tháng, sẽ lọc khi có thay đổi
        config.selectInputs?.forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => config.loader(true));
        });
    };

    // --- Khu vực Nhập kho ---
    setupLiveFilter({
        textInputs: ['importItemCodeFilter'],
        selectInputs: ['importFromDate', 'importToDate'],
        loader: loadImportHistory
    });

    // --- Khu vực Xuất kho ---
    setupLiveFilter({
        textInputs: ['exportItemCodeFilter'],
        selectInputs: ['exportFromDate', 'exportToDate'],
        loader: loadExportHistory
    });

    // --- Khu vực Chuyển kho ---
    setupLiveFilter({
        textInputs: ['transferItemCodeFilter'],
        selectInputs: ['transferFromDate', 'transferToDate'],
        loader: loadTransferHistory
    });

    // --- Khu vực Chỉnh số (Super Admin) ---
    setupLiveFilter({
        textInputs: ['adjustItemCodeFilter'],
        selectInputs: ['adjustFromDate', 'adjustToDate'],
        loader: loadDirectAdjustHistory
    });

    // --- Khu vực Yêu cầu Chỉnh số (Admin) ---
    setupLiveFilter({
        selectInputs: ['requestFromDate', 'requestToDate', 'requestStatusFilter'],
        loader: loadAdjustRequests
    });
}


// Transfer Details View Function
window.viewTransferDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu chuyển kho', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createTransferDetailsModal(data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading transfer details:', error);
        showToast('Lỗi tải chi tiết phiếu chuyển kho', 'danger');
    }
};

// Thay thế hàm này trong warehouse.js

function createTransferDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const quantity = data.quantity || 0;

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-info text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-exchange-alt"></i> Chi tiết phiếu chuyển kho
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- THÔNG BÁO THÀNH CÔNG -->
                    <div class="alert alert-info d-flex align-items-center mb-4">
                        <i class="fas fa-check-circle fa-2x me-3"></i>
                        <div>
                            <strong>Chuyển kho thành công</strong><br>
                            <small>Đã chuyển ${quantity} ${data.unit || ''} từ ${data.fromLocation} đến ${data.toLocation}</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-12 mb-2">
                            <span class="badge bg-info">
                                <i class="fas fa-exchange-alt"></i> Phiếu chuyển kho
                            </span>
                        </div>
                        <div class="col-md-6"><strong>Mã hàng:</strong> ${data.itemCode}</div>
                        <div class="col-md-6"><strong>Người thực hiện:</strong> ${data.performedByName}</div>
                        <div class="col-md-6"><strong>Tên mô tả:</strong> ${data.itemName}</div>
                        <div class="col-md-6"><strong>Thời gian:</strong> ${date}</div>
                    </div>

                    <!-- THÔNG TIN CHUYỂN KHO -->
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-route me-2"></i>Chi tiết chuyển kho
                    </h6>
                    <div class="row text-center mb-4">
                        <!-- TỪ VỊ TRÍ -->
                        <div class="col">
                            <div class="card h-100 border-secondary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">
                                        <i class="fas fa-map-marker-alt"></i> TỪ VỊ TRÍ
                                    </h6>
                                    <p class="card-text fs-5 fw-bold text-secondary">${data.fromLocation}</p>
                                    <small class="text-muted">Vị trí nguồn</small>
                                </div>
                            </div>
                        </div>

                        <!-- SỐ LƯỢNG CHUYỂN -->
                        <div class="col-auto d-flex align-items-center">
                            <div class="text-center">
                                <i class="fas fa-arrow-right fa-2x text-info mb-2"></i>
                                <div class="card border-info">
                                    <div class="card-body p-2">
                                        <h6 class="card-title text-muted mb-1">SỐ LƯỢNG</h6>
                                        <p class="card-text fs-4 fw-bold text-info mb-0">
                                            ${quantity}
                                        </p>
                                        <small class="text-muted">${data.unit || ''}</small>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- ĐẾN VỊ TRÍ -->
                        <div class="col">
                            <div class="card h-100 border-success">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">
                                        <i class="fas fa-map-marker-alt"></i> ĐẾN VỊ TRÍ
                                    </h6>
                                    <p class="card-text fs-5 fw-bold text-success">${data.toLocation}</p>
                                    <small class="text-muted">Vị trí đích</small>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- GHI CHÚ -->
                    ${data.note ? `
                        <div class="mb-3">
                            <strong>Ghi chú:</strong>
                            <p class="ms-2 mt-1 mb-0 fst-italic bg-light p-2 rounded">${data.note}</p>
                        </div>
                    ` : ''}

                    <!-- THÔNG TIN TÁC ĐỘNG 
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> 
                        <br>• Trừ ${quantity} ${data.unit || ''} khỏi vị trí "${data.fromLocation}"
                        <br>• Cộng ${quantity} ${data.unit || ''} vào vị trí "${data.toLocation}"
                    </div>-->
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}




// Adjust Details View Function
window.viewAdjustDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu chỉnh số', 'danger');
            return;
        }

        const data = docSnap.data();

        // Chuyển đổi dữ liệu transaction thành format giống adjust request
        const adjustRequestData = {
            itemCode: data.itemCode,
            itemName: data.itemName,
            location: data.location,
            currentQuantity: data.previousQuantity,
            requestedQuantity: data.newQuantity,
            adjustment: data.adjustment,
            reason: data.reason,
            status: 'approved', // Vì đây là transaction đã hoàn thành
            requestedByName: data.requestedByName || data.performedByName,
            timestamp: data.timestamp,
            approvedByName: data.performedByName,
            approvedDate: data.timestamp,
            requestDate: data.timestamp, // Có thể khác nếu có thông tin riêng
            requestId: data.requestId // Để biết có phải từ yêu cầu không
        };

        const modal = createAdjustRequestDetailsModal(adjustRequestData);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading adjust details:', error);
        showToast('Lỗi tải chi tiết phiếu chỉnh số', 'danger');
    }
};


// Thay thế hàm này trong warehouse.js

function createAdjustDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const adjustment = data.adjustment || 0;
    const adjustmentClass = adjustment > 0 ? 'text-success' : adjustment < 0 ? 'text-danger' : '';
    const adjustmentSymbol = adjustment > 0 ? '+' : '';

    // Xác định trạng thái (cho giao dịch đã hoàn thành)
    const status = { class: 'bg-success', text: 'Đã thực hiện' };

    // Thông tin thực hiện (có thể là từ yêu cầu hoặc trực tiếp)
    let performerInfo = '';
    let requestInfo = '';

    if (data.requestId) {
        // Từ yêu cầu chỉnh số
        performerInfo = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName || 'N/A'}</div>
            <div class="col-md-6"><strong>Người duyệt:</strong> ${data.performedByName}</div>
        `;
        requestInfo = `
            <div class="col-12">
                <span class="badge bg-info">
                    <i class="fas fa-clipboard-check"></i> Được tạo từ yêu cầu chỉnh số
                </span>
            </div>
        `;
    } else {
        // Chỉnh số trực tiếp (trước kia)
        performerInfo = `
            <div class="col-md-6"><strong>Người thực hiện:</strong> ${data.performedByName}</div>
        `;
    }

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Chi tiết chỉnh số tồn kho</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-md-6"><strong>Mã hàng:</strong> ${data.itemCode}</div>
                        <div class="col-md-6"><strong>Tên mô tả:</strong> ${data.itemName}</div>
                        <div class="col-md-6"><strong>Vị trí:</strong> ${data.location || 'N/A'}</div>
                        <div class="col-md-6"><strong>Trạng thái:</strong> <span class="badge ${status.class}">${status.text}</span></div>
                        ${performerInfo}
                        <div class="col-md-6"><strong>Thời gian thực hiện:</strong> ${date}</div>
                        ${requestInfo}
                    </div>

                    <!-- THÔNG TIN THAY ĐỔI -->
                    <div class="row text-center mt-4">
                        <div class="col-4">
                            <div class="card h-100">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Số lượng trước</h6>
                                    <p class="card-text fs-4">${data.previousQuantity}</p>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Số lượng sau</h6>
                                    <p class="card-text fs-4 fw-bold text-primary">${data.newQuantity}</p>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Chênh lệch</h6>
                                    <p class="card-text fs-4 fw-bold ${adjustmentClass}">${adjustmentSymbol}${adjustment}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- LÝ DO -->
                    <div class="mt-4">
                        <strong>Lý do chỉnh số:</strong>
                        <p class="ms-2 mt-1 mb-0 fst-italic bg-light p-2 rounded">${data.reason}</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}


// Pagination utility functions
function createPaginationComponent(containerId, data, renderFunction, itemsPerPage = 15) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let currentPage = 1;
    const totalPages = Math.ceil(data.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, data.length);
        const pageData = data.slice(startIndex, endIndex);

        renderFunction(pageData);
        updatePaginationControls(page, totalPages, data.length, startIndex, endIndex);
    }

    function updatePaginationControls(page, totalPages, totalItems, startIndex, endIndex) {
        // Create pagination HTML
        let paginationHTML = `
            <div class="d-flex justify-content-between align-items-center mt-3">
                <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${totalItems} kết quả</small>
                <nav>
                    <ul class="pagination pagination-sm mb-0">
        `;

        // Previous button
        paginationHTML += `
            <li class="page-item ${page === 1 ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="goToPage(${page - 1})">Trước</a>
            </li>
        `;

        // Page numbers
        const maxVisiblePages = 5;
        let startPage = Math.max(1, page - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

        for (let i = startPage; i <= endPage; i++) {
            paginationHTML += `
                <li class="page-item ${i === page ? 'active' : ''}">
                    <a class="page-link" href="#" onclick="goToPage(${i})">${i}</a>
                </li>
            `;
        }

        // Next button
        paginationHTML += `
            <li class="page-item ${page === totalPages ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="goToPage(${page + 1})">Sau</a>
            </li>
                    </ul>
                </nav>
            </div>
        `;

        // Add pagination to container
        const existingPagination = container.querySelector('.pagination-container');
        if (existingPagination) {
            existingPagination.remove();
        }

        const paginationDiv = document.createElement('div');
        paginationDiv.className = 'pagination-container';
        paginationDiv.innerHTML = paginationHTML;
        container.appendChild(paginationDiv);

        // Store goToPage function globally for this container
        window.goToPage = function (newPage) {
            if (newPage >= 1 && newPage <= totalPages) {
                currentPage = newPage;
                renderPage(currentPage);
            }
        };
    }

    // Initial render
    renderPage(1);

    return {
        refresh: (newData) => {
            data = newData;
            currentPage = 1;
            renderPage(1);
        }
    };
}

function createExportPagination(allData, container) {
    let currentPage = 1;
    const itemsPerPage = 15;
    const totalPages = Math.ceil(allData.length / itemsPerPage);

    function renderPage(page) {
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, allData.length);
        const pageData = allData.slice(startIndex, endIndex);

        const table = document.createElement('table');
        table.className = 'table table-striped table-compact';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Số phiếu / Người yêu cầu</th>
                    <th>Người nhận / Trạng thái</th>
                    <th>Số mặt hàng</th>
                    <th>Người thực hiện</th>
                    <th>Ngày tạo</th>
                    <th class="text-center">Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');

        pageData.forEach(data => {
            const row = document.createElement('tr');
            const date = data.timestamp ? data.timestamp.toDate().toLocaleDateString('vi-VN') : 'N/A';
            let actionButtons = '';

            if (data.dataType === 'pending') {
                // --- HIỂN THỊ CHO YÊU CẦU CHỜ DUYỆT ---
                row.classList.add('table-warning'); // Tô màu vàng cho yêu cầu

                // Chỉ admin và super_admin mới thấy các nút này
                if (userRole !== 'staff') {
                    actionButtons = `
                        <button class="btn btn-info btn-sm me-1" onclick="viewExportRequestDetails('${data.docId}')"><i class="fas fa-eye"></i>Xem</button>
                        <button class="btn btn-success btn-sm me-1" onclick="approveExportRequest('${data.docId}')"><i class="fas fa-check"></i>Duyệt</button>
                        <button class="btn btn-danger btn-sm" onclick="rejectExportRequest('${data.docId}')"><i class="fas fa-times"></i>Từ chối</button>
                    `;
                }
                
                row.innerHTML = `
                    <td>Yêu cầu từ: <strong>${data.requestedByName}</strong></td>
                    <td><span class="badge bg-warning text-dark">Chờ duyệt</span></td>
                    <td>${data.items?.length || 0}</td>
                    <td>Chưa có</td>
                    <td>${date}</td>
                    <td class="text-center">${actionButtons}</td>
                `;

            } else {
                // --- HIỂN THỊ CHO PHIẾU ĐÃ HOÀN THÀNH ---
                actionButtons = `<button class="btn btn-info btn-sm me-1" onclick="viewExportDetails('${data.docId}')"><i class="fas fa-eye"></i>Xem</button>`;
                
                // Chỉ Super Admin mới có quyền Sửa/Xóa
                if (userRole === 'super_admin') {
                    actionButtons += `
                        <button class="btn btn-warning btn-sm me-1" onclick="editExportTransaction('${data.docId}')"><i class="fas fa-edit"></i>Sửa</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteExportTransaction('${data.docId}')"><i class="fas fa-trash"></i>Xóa</button>
                    `;
                }
                
                row.innerHTML = `
                    <td>${data.exportNumber}</td>
                    <td>${data.recipient}</td>
                    <td>${data.items?.length || 0}</td>
                    <td>${data.performedByName}</td>
                    <td>${date}</td>
                    <td class="text-center">${actionButtons}</td>
                `;
            }
            tbody.appendChild(row);
        });

        // Create pagination
        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        paginationContainer.innerHTML = `
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${allData.length} kết quả</small>
            <nav aria-label="Export pagination">
                <ul class="pagination pagination-sm mb-0" id="exportPagination">
                </ul>
            </nav>
        `;

        container.innerHTML = '';
        container.appendChild(table);
        container.appendChild(paginationContainer);

        updatePaginationControls(page, totalPages, 'exportPagination', renderPage);
    }

    renderPage(1);
}

window.viewExportRequestDetails = async function(requestId) {
    try {
        const requestDoc = await getDoc(doc(db, 'export_requests', requestId));
        if (!requestDoc.exists()) {
            return showToast('Không tìm thấy yêu cầu xuất kho.', 'danger');
        }
        
        const req = requestDoc.data();
        const date = req.timestamp.toDate().toLocaleString('vi-VN');
        
        // Tạo bảng HTML cho các mặt hàng
        let itemsHtml = req.items.map(item => `
            <tr>
                <td>${item.code}</td>
                <td>${item.name}</td>
                <td><strong>${item.quantity}</strong> / ${item.availableQuantityBefore}</td>
                <td>${item.unit}</td>
            </tr>
        `).join('');

        const modal = document.createElement('div');
        modal.className = 'modal fade';
        modal.innerHTML = `
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header bg-primary text-white">
                        <h5 class="modal-title"><i class="fas fa-file-invoice"></i> Chi tiết Yêu cầu Xuất kho</h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="alert alert-info d-flex align-items-center mb-4">
                        <i class="fas fa-clock fa-2x me-3"></i>
                        <div>
                            <strong>Yêu cầu đang chờ phê duyệt</strong><br>
                            <small>Thông tin này chưa được áp dụng vào tồn kho chính thức.</small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG - ĐÃ CẬP NHẬT -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-md-6"><strong>Số phiếu yêu cầu:</strong> ${req.exportNumber || 'N/A'}</div>
                        <div class="col-md-6"><strong>Người nhận (đề xuất):</strong> ${req.recipient || 'N/A'}</div>
                        <div class="col-md-6"><strong>Người yêu cầu:</strong> ${req.requestedByName}</div>
                        <div class="col-md-6"><strong>Thời gian yêu cầu:</strong> ${date}</div>
                        <div class="col-md-6"><strong>Trạng thái:</strong> <span class="badge bg-warning text-dark">Chờ duyệt</span></div>
                    </div>

                        <h6>Danh sách hàng hóa yêu cầu:</h6>
                        <div class="table-responsive">
                            <table class="table table-sm table-bordered">
                                <thead class="table-light">
                                    <tr>
                                        <th>Mã hàng</th>
                                        <th>Tên</th>
                                        <th>SL Yêu cầu / Tồn kho</th>
                                        <th>Đơn vị</th>
                                    </tr>
                                </thead>
                                <tbody>${itemsHtml}</tbody>
                            </table>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        new bootstrap.Modal(modal).show();
        modal.addEventListener('hidden.bs.modal', () => modal.remove());

    } catch (e) {
        console.error("Lỗi khi xem chi tiết yêu cầu xuất kho:", e);
        showToast('Lỗi xem chi tiết yêu cầu.', 'danger');
    }
}

window.approveExportRequest = async function(requestId) {
    const confirmed = await showConfirmation(
        'Duyệt Yêu cầu Xuất kho', 
        'Bạn có chắc muốn duyệt yêu cầu này? Tồn kho sẽ bị trừ ngay lập tức và không thể hoàn tác.', 
        'Duyệt và Xuất kho', 'Hủy', 'success'
    );
    if (!confirmed) return;

    try {
        const requestRef = doc(db, 'export_requests', requestId);
        const requestSnap = await getDoc(requestRef);
        if (!requestSnap.exists() || requestSnap.data().status !== 'pending') {
            return showToast('Yêu cầu không còn tồn tại hoặc đã được xử lý.', 'warning');
        }
        
        const reqData = requestSnap.data();
        const batch = writeBatch(db);

        const itemsForTransaction = reqData.items;

        // 1. Tạo một phiếu xuất kho (transaction) mới từ yêu cầu
        const transRef = doc(collection(db, 'transactions'));
        batch.set(transRef, {
            type: 'export',
            exportNumber: reqData.exportNumber || `REQ-${requestId.substring(0, 8).toUpperCase()}`,
            recipient: reqData.recipient || `Theo YC của ${reqData.requestedByName}`,
            items: itemsForTransaction, // Sử dụng trực tiếp dữ liệu đã đúng
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            requestInfo: {
                id: requestId,
                requestedBy: reqData.requestedBy,
                requestedByName: reqData.requestedByName,
            },
            timestamp: serverTimestamp(),
            source: 'request'
        });

        // 2. Trừ tồn kho cho từng mặt hàng
        for (const item of reqData.items) {
            const invRef = doc(db, 'inventory', item.inventoryId);
            // Kiểm tra lại tồn kho trước khi trừ để đảm bảo an toàn
            const invSnap = await getDoc(invRef);
            if (!invSnap.exists() || invSnap.data().quantity < item.requestedQuantity) {
                throw new Error(`Không đủ tồn kho cho sản phẩm ${item.code}.`);
            }
             batch.update(invRef, { quantity: increment(-item.quantity) }); 
        }

        // 3. Cập nhật trạng thái của yêu cầu thành 'approved'
        batch.update(requestRef, {
            status: 'approved',
            approvedBy: currentUser.uid,
            approvedByName: currentUser.name,
            approvedAt: serverTimestamp()
        });
        
        await batch.commit();
        showToast('Duyệt yêu cầu xuất kho thành công!', 'success');
        loadExportHistory(); // Tải lại danh sách để cập nhật giao diện

    } catch (e) {
        console.error("Lỗi khi duyệt yêu cầu xuất kho:", e);
        showToast(e.message || 'Lỗi khi duyệt yêu cầu.', 'danger');
    }
}

window.rejectExportRequest = async function(requestId) {
    const reason = await showInputModal('Lý do từ chối', 'Vui lòng nhập lý do từ chối yêu cầu xuất kho này:', 'VD: Hàng đã được đặt cho đơn khác...');
    if (reason === null) return; // Người dùng đã nhấn hủy
    if (!reason) {
        showToast('Lý do từ chối không được để trống.', 'warning');
        return;
    }

    try {
        const requestRef = doc(db, 'export_requests', requestId);
        await updateDoc(requestRef, {
            status: 'rejected',
            rejectedBy: currentUser.uid,
            rejectedByName: currentUser.name,
            rejectedAt: serverTimestamp(),
            rejectionReason: reason
        });
        showToast('Đã từ chối yêu cầu xuất kho.', 'success');
        loadExportHistory(); // Tải lại danh sách để cập nhật giao diện
    } catch (e) {
        console.error("Lỗi khi từ chối yêu cầu xuất kho:", e);
        showToast('Lỗi khi từ chối yêu cầu.', 'danger');
    }
}

function updatePaginationControls(currentPage, totalPages, paginationId, renderFunction) {
    const pagination = document.getElementById(paginationId);
    if (!pagination) return;

    let paginationHTML = '';

    // Previous button
    paginationHTML += `
        <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
            <a class="page-link" href="#" data-page="${currentPage - 1}">Trước</a>
        </li>
    `;

    // Page numbers
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `
            <li class="page-item ${i === currentPage ? 'active' : ''}">
                <a class="page-link" href="#" data-page="${i}">${i}</a>
            </li>
        `;
    }

    // Next button
    paginationHTML += `
        <li class="page-item ${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}">
            <a class="page-link" href="#" data-page="${currentPage + 1}">Sau</a>
        </li>
    `;

    pagination.innerHTML = paginationHTML;

    // Add event listeners
    const links = pagination.querySelectorAll('.page-link[data-page]');
    links.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const page = parseInt(this.dataset.page);
            if (page >= 1 && !this.parentElement.classList.contains('disabled')) {
                renderFunction(page);
            }
        });
    });
}

// User Approval Details View Function
window.viewUserApprovalDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy thông tin phê duyệt', 'danger');
            return;
        }

        const data = docSnap.data();

        // Get user details
        const userDoc = await getDoc(doc(db, 'users', data.userId));
        const userData = userDoc.exists() ? userDoc.data() : { email: 'N/A', name: 'N/A' };

        const modal = createUserApprovalDetailsModal(data, userData);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading user approval details:', error);
        showToast('Lỗi tải chi tiết phê duyệt user', 'danger');
    }
};

// Thay thế hàm này trong warehouse.js

function createUserApprovalDetailsModal(data, userData) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';

    // Chuẩn bị các biến cho hiển thị hành động
    const isApproved = data.action === 'approved';
    const actionText = isApproved ? 'Phê duyệt người dùng' : 'Từ chối người dùng';
    const actionBadgeClass = isApproved ? 'bg-success' : 'bg-danger';
    const actionIconClass = isApproved ? 'fas fa-user-check' : 'fas fa-user-times';
    const headerClass = isApproved ? 'modal-header bg-primary text-white' : 'modal-header bg-danger text-white';
    const alertClass = isApproved ? 'alert-success' : 'alert-danger';

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="${headerClass}">
                    <h5 class="modal-title">
                        <i class="${actionIconClass}"></i> Chi tiết ${actionText.toLowerCase()}
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- THÔNG BÁO TRẠNG THÁI -->
                    <div class="alert ${alertClass} d-flex align-items-center mb-4">
                        <i class="${actionIconClass} fa-2x me-3"></i>
                        <div>
                            <strong>${actionText} thành công</strong><br>
                            <small>
                                ${isApproved ?
            `Người dùng ${userData.name || userData.email} đã được cấp quyền truy cập hệ thống` :
            `Yêu cầu truy cập của ${userData.name || userData.email} đã bị từ chối`
        }
                            </small>
                        </div>
                    </div>

                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 p-3 bg-light rounded border">
                        <div class="col-12 mb-2">
                            <span class="badge ${actionBadgeClass}">
                                <i class="${actionIconClass}"></i> ${actionText}
                            </span>
                        </div>
                        <div class="col-md-6"><strong>Tên người dùng:</strong> ${userData.name || 'N/A'}</div>
                        <div class="col-md-6"><strong>Email:</strong> ${userData.email || 'N/A'}</div>
                        <div class="col-md-6"><strong>Người thực hiện:</strong> ${data.performedByName}</div>
                        <div class="col-md-6"><strong>Thời gian:</strong> ${date}</div>
                        ${userData.role ? `<div class="col-md-6"><strong>Vai trò:</strong> <span class="badge bg-secondary">${userData.role}</span></div>` : ''}
                        <div class="col-md-6"><strong>Trạng thái tài khoản:</strong> 
                            <span class="badge ${isApproved ? 'bg-success' : 'bg-danger'}">
                                ${isApproved ? 'Đã kích hoạt' : 'Bị từ chối'}
                            </span>
                        </div>
                    </div>

                    <!-- CHI TIẾT HÀNH ĐỘNG -->
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-cogs me-2"></i>Chi tiết hành động
                    </h6>
                    <div class="row text-center mb-4">
                        <div class="col-4">
                            <div class="card h-100 ${isApproved ? 'border-success' : 'border-danger'}">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Trạng thái trước</h6>
                                    <p class="card-text">
                                        <span class="badge bg-warning text-dark">Chờ duyệt</span>
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100 border-primary">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Hành động</h6>
                                    <p class="card-text">
                                        <i class="${actionIconClass} fa-2x ${isApproved ? 'text-success' : 'text-danger'}"></i>
                                    </p>
                                    <small class="text-muted">${actionText}</small>
                                </div>
                            </div>
                        </div>
                        <div class="col-4">
                            <div class="card h-100 ${isApproved ? 'border-success' : 'border-danger'}">
                                <div class="card-body">
                                    <h6 class="card-title text-muted">Trạng thái sau</h6>
                                    <p class="card-text">
                                        <span class="badge ${actionBadgeClass}">
                                            ${isApproved ? 'Đã kích hoạt' : 'Bị từ chối'}
                                        </span>
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- THÔNG TIN QUYỀN HẠN -->
                    ${isApproved ? `
                        <div class="mb-3">
                            <strong>Quyền hạn được cấp:</strong>
                            <div class="ms-2 mt-2">
                                <span class="badge bg-info me-2">
                                    <i class="fas fa-eye"></i> Xem dashboard
                                </span>
                                <span class="badge bg-info me-2">
                                    <i class="fas fa-history"></i> Xem lịch sử
                                </span>
                                ${userData.role === 'admin' || userData.role === 'super_admin' ? `
                                    <span class="badge bg-success me-2">
                                        <i class="fas fa-download"></i> Nhập kho
                                    </span>
                                    <span class="badge bg-warning me-2">
                                        <i class="fas fa-upload"></i> Xuất kho
                                    </span>
                                    <span class="badge bg-info me-2">
                                        <i class="fas fa-exchange-alt"></i> Chuyển kho
                                    </span>
                                    <span class="badge bg-secondary me-2">
                                        <i class="fas fa-edit"></i> Yêu cầu chỉnh số
                                    </span>
                                ` : ''}
                                ${userData.role === 'super_admin' ? `
                                    <span class="badge bg-primary me-2">
                                        <i class="fas fa-clipboard-check"></i> Duyệt chỉnh số
                                    </span>
                                    <span class="badge bg-danger me-2">
                                        <i class="fas fa-user-check"></i> Duyệt user
                                    </span>
                                ` : ''}
                            </div>
                        </div>
                    ` : ''}

                    <!-- THÔNG TIN TÁC ĐỘNG -->
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle me-2"></i>
                        <strong>Tác động:</strong> 
                        ${isApproved ?
            `Người dùng ${userData.name || userData.email} có thể đăng nhập và sử dụng hệ thống với vai trò ${userData.role || 'staff'}.` :
            `Người dùng ${userData.name || userData.email} không thể đăng nhập vào hệ thống.`
        }
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

window.editImportTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu nhập', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createEditImportModal(transactionId, data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading import for edit:', error);
        showToast('Lỗi tải thông tin phiếu nhập', 'danger');
    }
};

function createEditImportModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editImportModal';

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-warning">
                    <h5 class="modal-title text-dark">
                        <i class="fas fa-edit"></i> Sửa phiếu nhập kho
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Cảnh báo:</strong> Việc sửa phiếu nhập sẽ ảnh hưởng đến tồn kho. Hãy cẩn thận!
                    </div>
                    
                    <form id="editImportForm">
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <label class="form-label">Số phiếu nhập</label>
                                <input type="text" class="form-control" id="editImportNumber" value="${data.importNumber}" required>
                            </div>
                            <div class="col-md-6">
                                <label class="form-label">Nhà cung cấp</label>
                                <input type="text" class="form-control" id="editSupplier" value="${data.supplier}" required>
                            </div>
                        </div>
                        
                        <h6>Danh sách hàng hóa</h6>
                        <div class="table-responsive">
                            <table class="table table-bordered">
                                <thead>
                                    <tr>
                                        <th>Mã hàng</th>
                                        <th>Tên mô tả</th>
                                        <th>Số lượng</th>
                                        <th>Đơn vị tính</th>
                                        <th>Danh mục</th>
                                        <th>Vị trí</th>
                                    </tr>
                                </thead>
                                <tbody id="editImportItemsTable">
                                    ${data.items?.map(item => `
                                        <tr>
                                            <td>${item.code}</td>
                                            <td>${item.name}</td>
                                            <td><input type="number" class="form-control form-control-sm" value="${item.quantity}" min="0" data-original="${item.quantity}" onchange="markItemChanged(this)"></td>
                                            <td>${item.unit}</td>
                                            <td>${item.category}</td>
                                            <td>${item.location}</td>
                                        </tr>
                                    `).join('') || ''}
                                </tbody>
                            </table>
                        </div>
                        
                        <input type="hidden" id="editTransactionId" value="${transactionId}">
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-warning" onclick="saveEditImport()">
                        <i class="fas fa-save"></i> Lưu thay đổi
                    </button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

window.saveEditImport = async function () {
    const transactionId = document.getElementById('editTransactionId').value;
    const importNumber = document.getElementById('editImportNumber').value;
    const supplier = document.getElementById('editSupplier').value;

    if (!importNumber || !supplier) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    try {
        const originalDoc = await getDoc(doc(db, 'transactions', transactionId));
        const originalData = originalDoc.data();

        const rows = document.querySelectorAll('#editImportItemsTable tr');
        const newItems = Array.from(rows).map(row => {
            const cells = row.querySelectorAll('td');
            const quantityInput = row.querySelector('input[type="number"]');
            return {
                code: cells[0].textContent, name: cells[1].textContent,
                quantity: parseInt(quantityInput.value) || 0,
                unit: cells[3].textContent, category: cells[4].textContent, location: cells[5].textContent
            };
        });

        // --- LOGIC GHI LOG THÔNG MINH ---
        const changes = {};
        if (originalData.importNumber !== importNumber) {
            changes.importNumber = { from: originalData.importNumber, to: importNumber };
        }
        if (originalData.supplier !== supplier) {
            changes.supplier = { from: originalData.supplier, to: supplier };
        }
        // So sánh danh sách item (dùng JSON để so sánh đơn giản)
        if (JSON.stringify(originalData.items) !== JSON.stringify(newItems)) {
            changes.items_changed = { from: originalData.items.length, to: newItems.length };
        }

        if (Object.keys(changes).length === 0) {
            showToast('Không có thay đổi nào để lưu.', 'info');
            return;
        }

        const confirmed = await showConfirmation(
            'Xác nhận cập nhật',
            'Bạn có chắc muốn lưu thay đổi? Điều này sẽ ảnh hưởng đến tồn kho hiện tại.',
            'Lưu thay đổi', 'Hủy', 'warning'
        );
        if (!confirmed) return;

        const batch = writeBatch(db);

        // Update transaction...
        batch.update(doc(db, 'transactions', transactionId), {
            importNumber: importNumber,
            supplier: supplier,
            items: newItems,
            lastModified: serverTimestamp(),
            modifiedBy: currentUser.uid,
            modifiedByName: currentUser.name
        });

        // Update inventory...
        const quantityChanges = new Map();
        originalData.items.forEach(item => {
            quantityChanges.set(item.code, (quantityChanges.get(item.code) || 0) - item.quantity);
        });
        newItems.forEach(item => {
            quantityChanges.set(item.code, (quantityChanges.get(item.code) || 0) + item.quantity);
        });

        for (const [code, diff] of quantityChanges.entries()) {
            if (diff !== 0) {
                const q = query(collection(db, 'inventory'), where('code', '==', code), limit(1));
                const snap = await getDocs(q);
                if (!snap.empty) {
                    batch.update(snap.docs[0].ref, { quantity: increment(diff) });
                }
            }
        }

        // Log hành động sửa
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'import_edited',
            originalTransactionId: transactionId,
            changes: changes, // Chỉ lưu những gì đã thay đổi
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        showToast('Đã cập nhật phiếu nhập thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editImportModal')).hide();
        loadImportHistory();

    } catch (error) {
        console.error('Error updating import:', error);
        showToast('Lỗi cập nhật phiếu nhập', 'danger');
    }
};


window.deleteImportTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    const confirmed = await showConfirmation(
        'Xóa phiếu nhập kho',
        'Bạn có chắc muốn XÓA phiếu nhập này?<br><br><strong>⚠️ Cảnh báo:</strong><br>• Thao tác này không thể hoàn tác<br>• Sẽ trừ lại số lượng đã nhập khỏi tồn kho',
        'Xóa phiếu nhập',
        'Hủy',
        'danger'
    );

    if (!confirmed) return;

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu nhập', 'danger');
            return;
        }

        const data = docSnap.data();
        const batch = writeBatch(db);

        // Delete transaction
        batch.delete(doc(db, 'transactions', transactionId));

        // Revert inventory quantities
        for (const item of data.items || []) {
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', item.code)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (!snapshot.empty) {
                const inventoryDoc = snapshot.docs[0];
                batch.update(inventoryDoc.ref, {
                    quantity: increment(-item.quantity)
                });
            }
        }

        // Log deletion
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'import_deleted',
            originalTransactionId: transactionId,
            deletedImportNumber: data.importNumber,
            deletedItems: data.items,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã xóa phiếu nhập thành công!', 'success');
        loadImportHistory();

    } catch (error) {
        console.error('Error deleting import:', error);
        showToast('Lỗi xóa phiếu nhập', 'danger');
    }
};

// === EXPORT TRANSACTION EDIT/DELETE ===

window.editExportTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu xuất', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createEditExportModal(transactionId, data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading export for edit:', error);
        showToast('Lỗi tải thông tin phiếu xuất', 'danger');
    }
};

function createEditExportModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editExportModal';

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-warning">
                    <h5 class="modal-title text-dark">
                        <i class="fas fa-edit"></i> Sửa phiếu xuất kho
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Cảnh báo:</strong> Việc sửa phiếu xuất sẽ ảnh hưởng đến tồn kho. Hãy cẩn thận!
                    </div>
                    
                    <form id="editExportForm">
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <label class="form-label">Số phiếu xuất</label>
                                <input type="text" class="form-control" id="editExportNumber" value="${data.exportNumber}" required>
                            </div>
                            <div class="col-md-6">
                                <label class="form-label">Người nhận</label>
                                <input type="text" class="form-control" id="editRecipient" value="${data.recipient}" required>
                            </div>
                        </div>
                        
                        <h6>Danh sách hàng hóa</h6>
                        <div class="table-responsive">
                            <table class="table table-bordered">
                                <thead>
                                    <tr>
                                        <th>Mã hàng</th>
                                        <th>Tên mô tả</th>
                                        <th>Số lượng xuất</th>
                                        <th>Đơn vị tính</th>
                                    </tr>
                                </thead>
                                <tbody id="editExportItemsTable">
                                    ${data.items?.map(item => `
                                        <tr>
                                            <td>${item.code}</td>
                                            <td>${item.name}</td>
                                            <td><input type="number" class="form-control form-control-sm" value="${item.quantity}" min="0" data-original="${item.quantity}" onchange="markItemChanged(this)"></td>
                                            <td>${item.unit || ''}</td>
                                        </tr>
                                    `).join('') || ''}
                                </tbody>
                            </table>
                        </div>
                        
                        <input type="hidden" id="editExportTransactionId" value="${transactionId}">
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-warning" onclick="saveEditExport()">
                        <i class="fas fa-save"></i> Lưu thay đổi
                    </button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

window.saveEditExport = async function () {
    const transactionId = document.getElementById('editExportTransactionId').value;
    const exportNumber = document.getElementById('editExportNumber').value;
    const recipient = document.getElementById('editRecipient').value;

    if (!exportNumber || !recipient) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    const confirmed = await showConfirmation(
        'Xác nhận cập nhật',
        'Bạn có chắc muốn lưu thay đổi? Điều này sẽ ảnh hưởng đến tồn kho hiện tại.',
        'Lưu thay đổi',
        'Hủy',
        'warning'
    );

    if (!confirmed) return;

    try {
        const originalDoc = await getDoc(doc(db, 'transactions', transactionId));
        const originalData = originalDoc.data();

        const rows = document.querySelectorAll('#editExportItemsTable tr');
        const newItems = [];
        const quantityChanges = [];

        rows.forEach((row, index) => {
            const cells = row.querySelectorAll('td');
            const quantityInput = row.querySelector('input[type="number"]');

            if (cells.length >= 4 && quantityInput) {
                const originalItem = originalData.items[index];
                const newQuantity = parseInt(quantityInput.value) || 0;
                const originalQuantity = parseInt(quantityInput.dataset.original) || 0;
                const quantityDiff = newQuantity - originalQuantity;

                newItems.push({
                    code: cells[0].textContent,
                    name: cells[1].textContent,
                    quantity: newQuantity,
                    unit: cells[3].textContent
                });

                if (quantityDiff !== 0) {
                    quantityChanges.push({
                        code: cells[0].textContent,
                        quantityDiff: quantityDiff
                    });
                }
            }
        });

        const changes = {};
        if (originalData.exportNumber !== exportNumber) {
            changes.exportNumber = { from: originalData.exportNumber, to: exportNumber };
        }
        if (originalData.recipient !== recipient) {
            changes.recipient = { from: originalData.recipient, to: recipient };
        }
        if (JSON.stringify(originalData.items) !== JSON.stringify(newItems)) {
            changes.items_changed = { from: originalData.items.length, to: newItems.length };
        }

        const batch = writeBatch(db);

        // Update transaction
        batch.update(doc(db, 'transactions', transactionId), {
            exportNumber: exportNumber,
            recipient: recipient,
            items: newItems,
            lastModified: serverTimestamp(),
            modifiedBy: currentUser.uid,
            modifiedByName: currentUser.name
        });

        // Update inventory quantities (reverse logic for export)
        for (const change of quantityChanges) {
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', change.code)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (!snapshot.empty) {
                const inventoryDoc = snapshot.docs[0];
                // For export: if we increase export quantity, we decrease inventory
                batch.update(inventoryDoc.ref, {
                    quantity: increment(-change.quantityDiff)
                });
            }
        }

        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'export_edited',
            originalTransactionId: transactionId,
            changes: changes,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã cập nhật phiếu xuất thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editExportModal')).hide();
        loadExportHistory();

    } catch (error) {
        console.error('Error updating export:', error);
        showToast('Lỗi cập nhật phiếu xuất', 'danger');
    }
};

window.deleteExportTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    const confirmed = await showConfirmation(
        'Xóa phiếu xuất kho',
        'Bạn có chắc muốn XÓA phiếu xuất này?<br><br><strong>⚠️ Cảnh báo:</strong><br>• Thao tác này không thể hoàn tác<br>• Sẽ hoàn lại số lượng đã xuất vào tồn kho',
        'Xóa phiếu xuất',
        'Hủy',
        'danger'
    );

    if (!confirmed) return;

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu xuất', 'danger');
            return;
        }

        const data = docSnap.data();
        const batch = writeBatch(db);

        // Delete transaction
        batch.delete(doc(db, 'transactions', transactionId));

        // Restore inventory quantities
        for (const item of data.items || []) {
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', item.code)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (!snapshot.empty) {
                const inventoryDoc = snapshot.docs[0];
                batch.update(inventoryDoc.ref, {
                    quantity: increment(item.quantity)
                });
            }
        }

        // Log deletion
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'export_deleted',
            originalTransactionId: transactionId,
            deletedExportNumber: data.exportNumber,
            deletedItems: data.items,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã xóa phiếu xuất thành công!', 'success');
        loadExportHistory();

    } catch (error) {
        console.error('Error deleting export:', error);
        showToast('Lỗi xóa phiếu xuất', 'danger');
    }
};

// === TRANSFER TRANSACTION EDIT/DELETE ===

window.editTransferTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu chuyển kho', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createEditTransferModal(transactionId, data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Error loading transfer for edit:', error);
        showToast('Lỗi tải thông tin phiếu chuyển kho', 'danger');
    }
};

function createEditTransferModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editTransferModal';

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-warning">
                    <h5 class="modal-title text-dark">
                        <i class="fas fa-edit"></i> Sửa phiếu chuyển kho
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Cảnh báo:</strong> Việc sửa phiếu chuyển kho sẽ ảnh hưởng đến tồn kho tại các vị trí. Hãy cẩn thận!
                    </div>
                    
                    <form id="editTransferForm">
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <label class="form-label">Mã hàng</label>
                                <input type="text" class="form-control" value="${data.itemCode}" readonly>
                            </div>
                            <div class="col-md-6">
                                <label class="form-label">Tên mô tả</label>
                                <input type="text" class="form-control" value="${data.itemName}" readonly>
                            </div>
                        </div>
                        
                        <div class="row mb-3">
                            <div class="col-md-4">
                                <label class="form-label">Từ vị trí</label>
                                <input type="text" class="form-control" id="editFromLocation" value="${data.fromLocation}" required>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label">Đến vị trí</label>
                                <input type="text" class="form-control" id="editToLocation" value="${data.toLocation}" required>
                            </div>
                            <div class="col-md-4">
                                <label class="form-label">Số lượng chuyển</label>
                                <input type="number" class="form-control" id="editTransferQuantity" value="${data.quantity}" min="1" required data-original="${data.quantity}">
                            </div>
                        </div>
                        
                        <div class="mb-3">
                            <label class="form-label">Ghi chú</label>
                            <textarea class="form-control" id="editTransferNote" rows="2">${data.note || ''}</textarea>
                        </div>
                        
                        <input type="hidden" id="editTransferTransactionId" value="${transactionId}">
                        <input type="hidden" id="editTransferItemCode" value="${data.itemCode}">
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-warning" onclick="saveEditTransfer()">
                        <i class="fas fa-save"></i> Lưu thay đổi
                    </button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

window.saveEditTransfer = async function () {
    const transactionId = document.getElementById('editTransferTransactionId').value;
    const itemCode = document.getElementById('editTransferItemCode').value;
    const fromLocation = document.getElementById('editFromLocation').value;
    const toLocation = document.getElementById('editToLocation').value;
    const newQuantity = parseInt(document.getElementById('editTransferQuantity').value);
    const originalQuantity = parseInt(document.getElementById('editTransferQuantity').dataset.original);
    const note = document.getElementById('editTransferNote').value;

    if (!fromLocation || !toLocation || !newQuantity) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    if (fromLocation === toLocation) {
        showToast('Vị trí nguồn và đích không được giống nhau', 'warning');
        return;
    }

    const confirmed = await showConfirmation(
        'Xác nhận cập nhật',
        'Bạn có chắc muốn lưu thay đổi? Điều này sẽ ảnh hưởng đến tồn kho tại các vị trí.',
        'Lưu thay đổi',
        'Hủy',
        'warning'
    );

    if (!confirmed) return;

    try {
        const originalDoc = await getDoc(doc(db, 'transactions', transactionId));
        const originalData = originalDoc.data();

        const batch = writeBatch(db);

        // Update transaction
        batch.update(doc(db, 'transactions', transactionId), {
            fromLocation: fromLocation,
            toLocation: toLocation,
            quantity: newQuantity,
            note: note,
            lastModified: serverTimestamp(),
            modifiedBy: currentUser.uid,
            modifiedByName: currentUser.name
        });

        // Revert original transfer effect
        const originalFromQuery = query(
            collection(db, 'inventory'),
            where('code', '==', itemCode),
            where('location', '==', originalData.fromLocation)
        );
        const originalFromSnapshot = await getDocs(originalFromQuery);
        if (!originalFromSnapshot.empty) {
            batch.update(originalFromSnapshot.docs[0].ref, {
                quantity: increment(originalQuantity)
            });
        }

        const originalToQuery = query(
            collection(db, 'inventory'),
            where('code', '==', itemCode),
            where('location', '==', originalData.toLocation)
        );
        const originalToSnapshot = await getDocs(originalToQuery);
        if (!originalToSnapshot.empty) {
            batch.update(originalToSnapshot.docs[0].ref, {
                quantity: increment(-originalQuantity)
            });
        }

        // Apply new transfer effect
        const newFromQuery = query(
            collection(db, 'inventory'),
            where('code', '==', itemCode),
            where('location', '==', fromLocation)
        );
        const newFromSnapshot = await getDocs(newFromQuery);
        if (!newFromSnapshot.empty) {
            batch.update(newFromSnapshot.docs[0].ref, {
                quantity: increment(-newQuantity)
            });
        }

        const newToQuery = query(
            collection(db, 'inventory'),
            where('code', '==', itemCode),
            where('location', '==', toLocation)
        );
        const newToSnapshot = await getDocs(newToQuery);
        if (!newToSnapshot.empty) {
            batch.update(newToSnapshot.docs[0].ref, {
                quantity: increment(newQuantity)
            });
        } else {
            // Create new inventory record if doesn't exist
            const inventoryRef = doc(collection(db, 'inventory'));
            const sourceData = originalFromSnapshot.empty ? {} : originalFromSnapshot.docs[0].data();
            batch.set(inventoryRef, {
                code: itemCode,
                name: originalData.itemName,
                unit: originalData.unit || sourceData.unit || '',
                quantity: newQuantity,
                category: sourceData.category || '',
                location: toLocation,
                createdAt: serverTimestamp()
            });
        }

        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'transfer_edited',
            originalTransactionId: transactionId,
            itemCode: originalData.itemCode,
            changes: {
                fromLocation: { from: originalData.fromLocation, to: fromLocation },
                toLocation: { from: originalData.toLocation, to: toLocation },
                quantity: { from: originalData.quantity, to: newQuantity },
                note: { from: originalData.note, to: note }
            },
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã cập nhật phiếu chuyển kho thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editTransferModal')).hide();
        loadTransferHistory();

    } catch (error) {
        console.error('Error updating transfer:', error);
        showToast('Lỗi cập nhật phiếu chuyển kho', 'danger');
    }
};

window.deleteTransferTransaction = async function (transactionId) {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    const confirmed = await showConfirmation(
        'Xóa phiếu chuyển kho',
        'Bạn có chắc muốn XÓA phiếu chuyển kho này?<br><br><strong>⚠️ Cảnh báo:</strong><br>• Thao tác này không thể hoàn tác<br>• Sẽ hoàn nguyên số lượng về vị trí ban đầu',
        'Xóa phiếu chuyển',
        'Hủy',
        'danger'
    );

    if (!confirmed) return;

    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu chuyển kho', 'danger');
            return;
        }

        const data = docSnap.data();
        const batch = writeBatch(db);

        // Delete transaction
        batch.delete(doc(db, 'transactions', transactionId));

        // Revert transfer: add back to source, subtract from destination
        const fromQuery = query(
            collection(db, 'inventory'),
            where('code', '==', data.itemCode),
            where('location', '==', data.fromLocation)
        );
        const fromSnapshot = await getDocs(fromQuery);
        if (!fromSnapshot.empty) {
            batch.update(fromSnapshot.docs[0].ref, {
                quantity: increment(data.quantity)
            });
        }

        const toQuery = query(
            collection(db, 'inventory'),
            where('code', '==', data.itemCode),
            where('location', '==', data.toLocation)
        );
        const toSnapshot = await getDocs(toQuery);
        if (!toSnapshot.empty) {
            batch.update(toSnapshot.docs[0].ref, {
                quantity: increment(-data.quantity)
            });
        }

        // Log deletion
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'transfer_deleted',
            originalTransactionId: transactionId,
            deletedItemCode: data.itemCode,
            deletedQuantity: data.quantity,
            deletedFromLocation: data.fromLocation,
            deletedToLocation: data.toLocation,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã xóa phiếu chuyển kho thành công!', 'success');
        loadTransferHistory();

    } catch (error) {
        console.error('Error deleting transfer:', error);
        showToast('Lỗi xóa phiếu chuyển kho', 'danger');
    }
};

window.markItemChanged = function (input) {
    input.style.backgroundColor = '#fff3cd'; // Highlight changed items
    input.style.border = '1px solid #ffc107';
};

export function createConfirmationModal(title, message, confirmText = 'Xác nhận', cancelText = 'Hủy', type = 'warning') {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'confirmationModal';
    modal.setAttribute('tabindex', '-1');

    const iconMap = {
        'warning': 'fas fa-exclamation-triangle text-warning',
        'danger': 'fas fa-exclamation-circle text-danger',
        'info': 'fas fa-info-circle text-info',
        'question': 'fas fa-question-circle text-primary'
    };

    const buttonMap = {
        'warning': 'btn-warning',
        'danger': 'btn-danger',
        'info': 'btn-info',
        'question': 'btn-primary'
    };

    modal.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header border-0 pb-0">
                    <h5 class="modal-title">
                        <i class="${iconMap[type]}"></i> ${title}
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body pt-0">
                    <div class="text-center py-3">
                        <i class="${iconMap[type]} fa-3x mb-3"></i>
                        <p class="mb-0">${message}</p>
                    </div>
                </div>
                <div class="modal-footer border-0 pt-0">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${cancelText}</button>
                    <button type="button" class="btn ${buttonMap[type]}" id="confirmBtn">${confirmText}</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

export function showConfirmation(title, message, confirmText = 'Xác nhận', cancelText = 'Hủy', type = 'warning') {
    return new Promise((resolve) => {
        const modal = createConfirmationModal(title, message, confirmText, cancelText, type);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);

        const confirmBtn = modal.querySelector('#confirmBtn');
        const handleConfirm = () => {
            bsModal.hide();
            resolve(true);
        };

        const handleCancel = () => {
            bsModal.hide();
            resolve(false);
        };

        confirmBtn.addEventListener('click', handleConfirm);
        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

        // Handle cancel via close button or backdrop
        modal.addEventListener('hidden.bs.modal', handleCancel, { once: true });
        confirmBtn.addEventListener('click', () => {
            modal.removeEventListener('hidden.bs.modal', handleCancel);
        });

        bsModal.show();
    });
}

// Input Modal for getting text input
export function createInputModal(title, message, placeholder = '', inputType = 'text') {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'inputModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">
                        <i class="fas fa-edit text-primary"></i> ${title}
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <p class="mb-3">${message}</p>
                    <div class="form-group">
                        <input type="${inputType}" class="form-control" id="modalInput" placeholder="${placeholder}" required>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-primary" id="inputConfirmBtn">Xác nhận</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

export function showInputModal(title, message, placeholder = '', inputType = 'text') {
    return new Promise((resolve) => {
        const modal = createInputModal(title, message, placeholder, inputType);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);

        const inputField = modal.querySelector('#modalInput');
        const confirmBtn = modal.querySelector('#inputConfirmBtn');

        const handleConfirm = () => {
            const value = inputField.value.trim();
            if (value) {
                bsModal.hide();
                resolve(value);
            } else {
                inputField.classList.add('is-invalid');
                inputField.focus();
            }
        };

        const handleCancel = () => {
            bsModal.hide();
            resolve(null);
        };

        confirmBtn.addEventListener('click', handleConfirm);
        inputField.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleConfirm();
            }
        });

        inputField.addEventListener('input', () => {
            inputField.classList.remove('is-invalid');
        });

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

        modal.addEventListener('hidden.bs.modal', handleCancel, { once: true });
        confirmBtn.addEventListener('click', () => {
            modal.removeEventListener('hidden.bs.modal', handleCancel);
        });

        bsModal.show();

        // Auto focus input
        modal.addEventListener('shown.bs.modal', () => {
            inputField.focus();
        });
    });
}

// ===============================
// EXCEL FUNCTIONS FOR EXPORT
// ===============================

function downloadExportTemplate() {
    const data = [
        ['Mã hàng', 'Số lượng xuất'],
        ['SP-EXIST-01', '5'],
        ['SP-EXIST-02', '10']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Xuat_Kho');
    XLSX.writeFile(wb, 'mau-xuat-kho.xlsx');
}

function handleExportExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // Skip header row and process data
            const items = data.slice(1).filter(row => row.length >= 2).map(row => ({
                code: row[0]?.toString() || '',
                quantity: parseInt(row[1]) || 0
            }));

            if (items.length > 0) {
                showExportExcelImportModal(items);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ', 'warning');
            }

        } catch (error) {
            console.error('Error reading Excel file:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = '';
}

function showExportExcelImportModal(items) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-warning text-dark">
                    <h5 class="modal-title">Xác nhận xuất kho từ Excel</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="row mb-3">
                        <div class="col-md-6">
                            <label class="form-label">Số phiếu xuất <span class="text-danger">*</span></label>
                            <input type="text" class="form-control" id="excelExportNumber" required>
                        </div>
                        <div class="col-md-6">
                            <label class="form-label">Người nhận <span class="text-danger">*</span></label>
                            <input type="text" class="form-control" id="excelRecipient" required>
                        </div>
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelExportPreviewTable">
                            <thead class="table-warning">
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Số lượng xuất</th>
                                    <th>Tồn kho hiện tại</th>
                                    <th>Đơn vị tính</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-warning" onclick="saveExcelExport()" id="saveExcelExportBtn">
                        Xác nhận xuất kho
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Load item details and validate
    loadExportItemDetails(items);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

async function loadExportItemDetails(items) {
    const tbody = document.querySelector('#excelExportPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelExportBtn');
    let allValid = true;
    const validItems = [];

    tbody.innerHTML = '';

    for (const item of items) {
        const row = document.createElement('tr');
        
        try {
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', item.code),
                limit(1)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (snapshot.empty) {
                row.className = 'table-danger';
                row.innerHTML = `
                    <td>${item.code}</td>
                    <td>Không tìm thấy</td>
                    <td>${item.quantity}</td>
                    <td>-</td>
                    <td>-</td>
                    <td><span class="badge bg-danger">Không tồn tại</span></td>
                `;
                allValid = false;
            } else {
                const doc = snapshot.docs[0];
                const data = doc.data();
                
                if (item.quantity > data.quantity) {
                    row.className = 'table-warning';
                    allValid = false;
                    row.innerHTML = `
                        <td>${item.code}</td>
                        <td>${data.name}</td>
                        <td>${item.quantity}</td>
                        <td>${data.quantity}</td>
                        <td>${data.unit}</td>
                        <td><span class="badge bg-warning text-dark">Vượt tồn kho</span></td>
                    `;
                } else if (data.quantity === 0) {
                    row.className = 'table-danger';
                    allValid = false;
                    row.innerHTML = `
                        <td>${item.code}</td>
                        <td>${data.name}</td>
                        <td>${item.quantity}</td>
                        <td>${data.quantity}</td>
                        <td>${data.unit}</td>
                        <td><span class="badge bg-danger">Hết hàng</span></td>
                    `;
                } else {
                    row.className = 'table-success';
                    row.innerHTML = `
                        <td>${item.code}</td>
                        <td>${data.name}</td>
                        <td>${item.quantity}</td>
                        <td>${data.quantity}</td>
                        <td>${data.unit}</td>
                        <td><span class="badge bg-success">Hợp lệ</span></td>
                    `;
                    validItems.push({
                        inventoryId: doc.id,
                        code: item.code,
                        name: data.name,
                        quantity: item.quantity,
                        unit: data.unit,
                        availableQuantity: data.quantity
                    });
                }
            }
        } catch (error) {
            console.error('Error checking item:', error);
            row.className = 'table-danger';
            row.innerHTML = `
                <td>${item.code}</td>
                <td>Lỗi kiểm tra</td>
                <td>${item.quantity}</td>
                <td>-</td>
                <td>-</td>
                <td><span class="badge bg-danger">Lỗi</span></td>
            `;
            allValid = false;
        }
        
        tbody.appendChild(row);
    }

    saveBtn.disabled = !allValid || validItems.length === 0;
    window.validExportItems = validItems; // Store for saving
}

window.saveExcelExport = async function() {
    const exportNumber = document.getElementById('excelExportNumber').value.trim();
    const recipient = document.getElementById('excelRecipient').value.trim();

    if (!exportNumber || !recipient) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    if (!window.validExportItems || window.validExportItems.length === 0) {
        showToast('Không có mặt hàng hợp lệ để xuất', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);

        // Create export transaction
        const exportDoc = doc(collection(db, 'transactions'));
        batch.set(exportDoc, {
            type: 'export',
            exportNumber: exportNumber,
            recipient: recipient,
            items: window.validExportItems,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp(),
            source: 'excel'
        });

        // Update inventory quantities
        for (const item of window.validExportItems) {
            const inventoryDoc = doc(db, 'inventory', item.inventoryId);
            batch.update(inventoryDoc, {
                quantity: increment(-item.quantity)
            });
        }

        await batch.commit();

        showToast('Xuất kho từ Excel thành công!', 'success');
        bootstrap.Modal.getInstance(document.querySelector('.modal')).hide();
        loadExportHistory();

    } catch (error) {
        console.error('Error saving Excel export:', error);
        showToast('Lỗi lưu phiếu xuất từ Excel', 'danger');
    }
};

// ===============================
// EXCEL FUNCTIONS FOR TRANSFER
// ===============================

function downloadTransferTemplate() {
    const data = [
        ['Mã hàng', 'Số lượng chuyển', 'Từ vị trí', 'Đến vị trí', 'Ghi chú'],
        ['SP-EXIST-01', '5', 'A1-01', 'B2-03', 'Chuyển kho định kỳ']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Chuyen_Kho');
    XLSX.writeFile(wb, 'mau-chuyen-kho.xlsx');
}

function handleTransferExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // Skip header row and process data
            const transfers = data.slice(1).filter(row => row.length >= 4).map(row => ({
                code: row[0]?.toString() || '',
                quantity: parseInt(row[1]) || 0,
                fromLocation: row[2]?.toString() || '',
                toLocation: row[3]?.toString() || '',
                note: row[4]?.toString() || ''
            }));

            if (transfers.length > 0) {
                showTransferExcelImportModal(transfers);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ', 'warning');
            }

        } catch (error) {
            console.error('Error reading Excel file:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = '';
}

function showTransferExcelImportModal(transfers) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-info text-white">
                    <h5 class="modal-title">Xác nhận chuyển kho từ Excel</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelTransferPreviewTable">
                            <thead class="table-info">
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>SL chuyển</th>
                                    <th>Từ vị trí</th>
                                    <th>Đến vị trí</th>
                                    <th>Tồn kho tại vị trí nguồn</th>
                                    <th>Ghi chú</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-info" onclick="saveExcelTransfers()" id="saveExcelTransfersBtn">
                        Xác nhận chuyển kho
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Load transfer details and validate
    loadTransferItemDetails(transfers);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

async function loadTransferItemDetails(transfers) {
    const tbody = document.querySelector('#excelTransferPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelTransfersBtn');
    let allValid = true;
    const validTransfers = [];

    tbody.innerHTML = '';

    for (const transfer of transfers) {
        const row = document.createElement('tr');
        
        try {
            // Check if item exists at source location
            const sourceQuery = query(
                collection(db, 'inventory'),
                where('code', '==', transfer.code),
                where('location', '==', transfer.fromLocation),
                limit(1)
            );
            const sourceSnapshot = await getDocs(sourceQuery);

            if (sourceSnapshot.empty) {
                row.className = 'table-danger';
                row.innerHTML = `
                    <td>${transfer.code}</td>
                    <td>Không tìm thấy tại vị trí nguồn</td>
                    <td>${transfer.quantity}</td>
                    <td>${transfer.fromLocation}</td>
                    <td>${transfer.toLocation}</td>
                    <td>-</td>
                    <td>${transfer.note}</td>
                    <td><span class="badge bg-danger">Không tìm thấy</span></td>
                `;
                allValid = false;
            } else {
                const sourceDoc = sourceSnapshot.docs[0];
                const sourceData = sourceDoc.data();
                
                if (transfer.fromLocation === transfer.toLocation) {
                    row.className = 'table-warning';
                    allValid = false;
                    row.innerHTML = `
                        <td>${transfer.code}</td>
                        <td>${sourceData.name}</td>
                        <td>${transfer.quantity}</td>
                        <td>${transfer.fromLocation}</td>
                        <td>${transfer.toLocation}</td>
                        <td>${sourceData.quantity}</td>
                        <td>${transfer.note}</td>
                        <td><span class="badge bg-warning text-dark">Vị trí trùng nhau</span></td>
                    `;
                } else if (transfer.quantity > sourceData.quantity) {
                    row.className = 'table-warning';
                    allValid = false;
                    row.innerHTML = `
                        <td>${transfer.code}</td>
                        <td>${sourceData.name}</td>
                        <td>${transfer.quantity}</td>
                        <td>${transfer.fromLocation}</td>
                        <td>${transfer.toLocation}</td>
                        <td>${sourceData.quantity}</td>
                        <td>${transfer.note}</td>
                        <td><span class="badge bg-warning text-dark">Vượt tồn kho</span></td>
                    `;
                } else {
                    row.className = 'table-success';
                    row.innerHTML = `
                        <td>${transfer.code}</td>
                        <td>${sourceData.name}</td>
                        <td>${transfer.quantity}</td>
                        <td>${transfer.fromLocation}</td>
                        <td>${transfer.toLocation}</td>
                        <td>${sourceData.quantity}</td>
                        <td>${transfer.note}</td>
                        <td><span class="badge bg-success">Hợp lệ</span></td>
                    `;
                    validTransfers.push({
                        sourceInventoryId: sourceDoc.id,
                        code: transfer.code,
                        name: sourceData.name,
                        unit: sourceData.unit,
                        category: sourceData.category,
                        quantity: transfer.quantity,
                        fromLocation: transfer.fromLocation,
                        toLocation: transfer.toLocation,
                        note: transfer.note
                    });
                }
            }
        } catch (error) {
            console.error('Error checking transfer:', error);
            row.className = 'table-danger';
            row.innerHTML = `
                <td>${transfer.code}</td>
                <td>Lỗi kiểm tra</td>
                <td>${transfer.quantity}</td>
                <td>${transfer.fromLocation}</td>
                <td>${transfer.toLocation}</td>
                <td>-</td>
                <td>${transfer.note}</td>
                <td><span class="badge bg-danger">Lỗi</span></td>
            `;
            allValid = false;
        }
        
        tbody.appendChild(row);
    }

    saveBtn.disabled = !allValid || validTransfers.length === 0;
    window.validTransfers = validTransfers;
}

window.saveExcelTransfers = async function() {
    if (!window.validTransfers || window.validTransfers.length === 0) {
        showToast('Không có chuyển kho hợp lệ', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);

        for (const transfer of window.validTransfers) {
            // Update source inventory
            const sourceRef = doc(db, 'inventory', transfer.sourceInventoryId);
            batch.update(sourceRef, {
                quantity: increment(-transfer.quantity)
            });

            // Check if destination exists
            const destQuery = query(
                collection(db, 'inventory'),
                where('code', '==', transfer.code),
                where('location', '==', transfer.toLocation),
                limit(1)
            );
            const destSnapshot = await getDocs(destQuery);

            if (!destSnapshot.empty) {
                // Update existing destination
                const destRef = destSnapshot.docs[0].ref;
                batch.update(destRef, {
                    quantity: increment(transfer.quantity)
                });
            } else {
                // Create new destination record
                const newInventoryRef = doc(collection(db, 'inventory'));
                batch.set(newInventoryRef, {
                    code: transfer.code,
                    name: transfer.name,
                    unit: transfer.unit,
                    category: transfer.category,
                    quantity: transfer.quantity,
                    location: transfer.toLocation,
                    createdAt: serverTimestamp()
                });
            }

            // Log transaction
            const transactionRef = doc(collection(db, 'transactions'));
            batch.set(transactionRef, {
                type: 'transfer',
                itemCode: transfer.code,
                itemName: transfer.name,
                quantity: transfer.quantity,
                unit: transfer.unit,
                fromLocation: transfer.fromLocation,
                toLocation: transfer.toLocation,
                note: transfer.note,
                performedBy: currentUser.uid,
                performedByName: currentUser.name,
                date: serverTimestamp(),
                timestamp: serverTimestamp(),
                source: 'excel'
            });
        }

        await batch.commit();

        showToast('Chuyển kho từ Excel thành công!', 'success');
        bootstrap.Modal.getInstance(document.querySelector('.modal')).hide();
        loadTransferHistory();

    } catch (error) {
        console.error('Error saving Excel transfers:', error);
        showToast('Lỗi lưu chuyển kho từ Excel', 'danger');
    }
};

// ===============================
// EXCEL FUNCTIONS FOR ADJUST (Super Admin - Direct)
// ===============================

function downloadAdjustTemplate() {
    const data = [
        ['Mã hàng', 'Vị trí', 'Số lượng MỚI', 'Lý do điều chỉnh'],
        ['SP-EXIST-01', 'A1-01', '99', 'Kiểm kê phát hiện thừa']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Chinh_So');
    XLSX.writeFile(wb, 'mau-chinh-so.xlsx');
}

function handleAdjustExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // Skip header row and process data
            const adjustments = data.slice(1).filter(row => row.length >= 4).map(row => ({
                code: row[0]?.toString() || '',
                location: row[1]?.toString() || '',
                newQuantity: parseInt(row[2]) || 0,
                reason: row[3]?.toString() || ''
            }));

            if (adjustments.length > 0) {
                showAdjustExcelImportModal(adjustments);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ', 'warning');
            }

        } catch (error) {
            console.error('Error reading Excel file:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = '';
}

function showAdjustExcelImportModal(adjustments) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title">Xác nhận chỉnh số từ Excel (Super Admin)</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-danger">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Cảnh báo:</strong> Thao tác này sẽ thực hiện chỉnh số trực tiếp và không thể hoàn tác!
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelAdjustPreviewTable">
                            <thead class="table-danger">
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Vị trí</th>
                                    <th>SL hiện tại</th>
                                    <th>SL mới</th>
                                    <th>Chênh lệch</th>
                                    <th>Lý do</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-danger" onclick="saveExcelAdjustments()" id="saveExcelAdjustmentsBtn">
                        Thực hiện chỉnh số
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Load adjustment details and validate
    loadAdjustItemDetails(adjustments);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

async function loadAdjustItemDetails(adjustments) {
    const tbody = document.querySelector('#excelAdjustPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelAdjustmentsBtn');
    let allValid = true;
    const validAdjustments = [];

    tbody.innerHTML = '';

    for (const adjustment of adjustments) {
        const row = document.createElement('tr');
        
        try {
            // Find item at specific location
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', adjustment.code),
                where('location', '==', adjustment.location),
                limit(1)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (snapshot.empty) {
                row.className = 'table-danger';
                row.innerHTML = `
                    <td>${adjustment.code}</td>
                    <td>Không tìm thấy tại vị trí</td>
                    <td>${adjustment.location}</td>
                    <td>-</td>
                    <td>${adjustment.newQuantity}</td>
                    <td>-</td>
                    <td>${adjustment.reason}</td>
                    <td><span class="badge bg-danger">Không tìm thấy</span></td>
                `;
                allValid = false;
            } else {
                const doc = snapshot.docs[0];
                const data = doc.data();
                const difference = adjustment.newQuantity - data.quantity;
                
                if (adjustment.newQuantity < 0) {
                    row.className = 'table-warning';
                    allValid = false;
                    row.innerHTML = `
                        <td>${adjustment.code}</td>
                        <td>${data.name}</td>
                        <td>${adjustment.location}</td>
                        <td>${data.quantity}</td>
                        <td>${adjustment.newQuantity}</td>
                        <td>${difference >= 0 ? '+' : ''}${difference}</td>
                        <td>${adjustment.reason}</td>
                        <td><span class="badge bg-warning text-dark">Số lượng âm</span></td>
                    `;
                } else if (difference === 0) {
                    row.className = 'table-info';
                    row.innerHTML = `
                        <td>${adjustment.code}</td>
                        <td>${data.name}</td>
                        <td>${adjustment.location}</td>
                        <td>${data.quantity}</td>
                        <td>${adjustment.newQuantity}</td>
                        <td>0</td>
                        <td>${adjustment.reason}</td>
                        <td><span class="badge bg-info">Không thay đổi</span></td>
                    `;
                    // Don't add to valid adjustments since no change needed
                } else {
                    row.className = 'table-success';
                    row.innerHTML = `
                        <td>${adjustment.code}</td>
                        <td>${data.name}</td>
                        <td>${adjustment.location}</td>
                        <td>${data.quantity}</td>
                        <td>${adjustment.newQuantity}</td>
                        <td class="${difference > 0 ? 'text-success' : 'text-danger'}">${difference >= 0 ? '+' : ''}${difference}</td>
                        <td>${adjustment.reason}</td>
                        <td><span class="badge bg-success">Hợp lệ</span></td>
                    `;
                    validAdjustments.push({
                        inventoryId: doc.id,
                        code: adjustment.code,
                        name: data.name,
                        location: adjustment.location,
                        currentQuantity: data.quantity,
                        newQuantity: adjustment.newQuantity,
                        adjustment: difference,
                        reason: adjustment.reason
                    });
                }
            }
        } catch (error) {
            console.error('Error checking adjustment:', error);
            row.className = 'table-danger';
            row.innerHTML = `
                <td>${adjustment.code}</td>
                <td>Lỗi kiểm tra</td>
                <td>${adjustment.location}</td>
                <td>-</td>
                <td>${adjustment.newQuantity}</td>
                <td>-</td>
                <td>${adjustment.reason}</td>
                <td><span class="badge bg-danger">Lỗi</span></td>
            `;
            allValid = false;
        }
        
        tbody.appendChild(row);
    }

    saveBtn.disabled = !allValid || validAdjustments.length === 0;
    window.validAdjustments = validAdjustments;
}

window.saveExcelAdjustments = async function() {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
        return;
    }

    if (!window.validAdjustments || window.validAdjustments.length === 0) {
        showToast('Không có điều chỉnh hợp lệ', 'warning');
        return;
    }

    const confirmed = await showConfirmation(
        'Xác nhận chỉnh số hàng loạt',
        `Bạn có chắc muốn thực hiện ${window.validAdjustments.length} điều chỉnh tồn kho?<br><br><strong>Cảnh báo:</strong> Thao tác này không thể hoàn tác!`,
        'Thực hiện chỉnh số',
        'Hủy',
        'danger'
    );

    if (!confirmed) return;

    try {
        const batch = writeBatch(db);

        for (const adjustment of window.validAdjustments) {
            // Update inventory
            const inventoryRef = doc(db, 'inventory', adjustment.inventoryId);
            batch.update(inventoryRef, {
                quantity: adjustment.newQuantity
            });

            // Log transaction
            const transactionRef = doc(collection(db, 'transactions'));
            batch.set(transactionRef, {
                type: 'adjust',
                subtype: 'direct', // Mark as direct adjustment
                inventoryId: adjustment.inventoryId,
                itemCode: adjustment.code,
                itemName: adjustment.name,
                location: adjustment.location,
                previousQuantity: adjustment.currentQuantity,
                newQuantity: adjustment.newQuantity,
                adjustment: adjustment.adjustment,
                reason: adjustment.reason,
                performedBy: currentUser.uid,
                performedByName: currentUser.name,
                date: serverTimestamp(),
                timestamp: serverTimestamp(),
                source: 'excel'
            });
        }

        await batch.commit();

        showToast('Chỉnh số từ Excel thành công!', 'success');
        bootstrap.Modal.getInstance(document.querySelector('.modal')).hide();
        loadDirectAdjustHistory();

    } catch (error) {
        console.error('Error saving Excel adjustments:', error);
        showToast('Lỗi lưu điều chỉnh từ Excel', 'danger');
    }
};

// ===============================
// EXCEL FUNCTIONS FOR REQUEST ADJUST (Admin)
// ===============================

function downloadRequestAdjustTemplate() {
    const data = [
        ['Mã hàng', 'Vị trí', 'Số lượng ĐỀ XUẤT', 'Lý do yêu cầu'],
        ['SP-EXIST-01', 'A1-01', '101', 'Kiểm kê phát hiện thiếu']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Yeu_Cau_Chinh_So');
    XLSX.writeFile(wb, 'mau-yeu-cau-chinh-so.xlsx');
}

function handleRequestAdjustExcelImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // Skip header row and process data
            const requests = data.slice(1).filter(row => row.length >= 4).map(row => ({
                code: row[0]?.toString() || '',
                location: row[1]?.toString() || '',
                requestedQuantity: parseInt(row[2]) || 0,
                reason: row[3]?.toString() || ''
            }));

            if (requests.length > 0) {
                showRequestAdjustExcelImportModal(requests);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ', 'warning');
            }

        } catch (error) {
            console.error('Error reading Excel file:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = '';
}

function showRequestAdjustExcelImportModal(requests) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title">Xác nhận yêu cầu chỉnh số từ Excel</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle"></i>
                        <strong>Thông tin:</strong> Các yêu cầu sẽ được gửi đến Super Admin để phê duyệt.
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelRequestAdjustPreviewTable">
                            <thead class="table-primary">
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Vị trí</th>
                                    <th>SL hiện tại</th>
                                    <th>SL đề xuất</th>
                                    <th>Chênh lệch</th>
                                    <th>Lý do</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-primary" onclick="saveExcelRequestAdjustments()" id="saveExcelRequestAdjustmentsBtn">
                        Gửi yêu cầu
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    // Load request details and validate
    loadRequestAdjustItemDetails(requests);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

async function loadRequestAdjustItemDetails(requests) {
    const tbody = document.querySelector('#excelRequestAdjustPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelRequestAdjustmentsBtn');
    let allValid = true;
    const validRequests = [];

    tbody.innerHTML = '';

    for (const request of requests) {
        const row = document.createElement('tr');
        
        try {
            // Find item at specific location
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', request.code),
                where('location', '==', request.location),
                limit(1)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (snapshot.empty) {
                row.className = 'table-danger';
                row.innerHTML = `
                    <td>${request.code}</td>
                    <td>Không tìm thấy tại vị trí</td>
                    <td>${request.location}</td>
                    <td>-</td>
                    <td>${request.requestedQuantity}</td>
                    <td>-</td>
                    <td>${request.reason}</td>
                    <td><span class="badge bg-danger">Không tìm thấy</span></td>
                `;
                allValid = false;
            } else {
                const doc = snapshot.docs[0];
                const data = doc.data();
                const difference = request.requestedQuantity - data.quantity;
                
                if (request.requestedQuantity < 0) {
                    row.className = 'table-warning';
                    allValid = false;
                    row.innerHTML = `
                        <td>${request.code}</td>
                        <td>${data.name}</td>
                        <td>${request.location}</td>
                        <td>${data.quantity}</td>
                        <td>${request.requestedQuantity}</td>
                        <td>${difference >= 0 ? '+' : ''}${difference}</td>
                        <td>${request.reason}</td>
                        <td><span class="badge bg-warning text-dark">Số lượng âm</span></td>
                    `;
                } else if (difference === 0) {
                    row.className = 'table-info';
                    row.innerHTML = `
                        <td>${request.code}</td>
                        <td>${data.name}</td>
                        <td>${request.location}</td>
                        <td>${data.quantity}</td>
                        <td>${request.requestedQuantity}</td>
                        <td>0</td>
                        <td>${request.reason}</td>
                        <td><span class="badge bg-info">Không thay đổi</span></td>
                    `;
                    // Don't add to valid requests since no change needed
                } else {
                    row.className = 'table-success';
                    row.innerHTML = `
                        <td>${request.code}</td>
                        <td>${data.name}</td>
                        <td>${request.location}</td>
                        <td>${data.quantity}</td>
                        <td>${request.requestedQuantity}</td>
                        <td class="${difference > 0 ? 'text-success' : 'text-danger'}">${difference >= 0 ? '+' : ''}${difference}</td>
                        <td>${request.reason}</td>
                        <td><span class="badge bg-success">Hợp lệ</span></td>
                    `;
                    validRequests.push({
                        inventoryId: doc.id,
                        itemCode: data.code,
                        itemName: data.name,
                        location: request.location,
                        currentQuantity: data.quantity,
                        requestedQuantity: request.requestedQuantity,
                        adjustment: difference,
                        reason: request.reason
                    });
                }
            }
        } catch (error) {
            console.error('Error checking request:', error);
            row.className = 'table-danger';
            row.innerHTML = `
                <td>${request.code}</td>
                <td>Lỗi kiểm tra</td>
                <td>${request.location}</td>
                <td>-</td>
                <td>${request.requestedQuantity}</td>
                <td>-</td>
                <td>${request.reason}</td>
                <td><span class="badge bg-danger">Lỗi</span></td>
            `;
            allValid = false;
        }
        
        tbody.appendChild(row);
    }

    saveBtn.disabled = !allValid || validRequests.length === 0;
    window.validRequests = validRequests;
}

window.saveExcelRequestAdjustments = async function() {
    if (!window.validRequests || window.validRequests.length === 0) {
        showToast('Không có yêu cầu hợp lệ', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);

        for (const request of window.validRequests) {
            // Create adjustment request
            const requestRef = doc(collection(db, 'adjustment_requests'));
            batch.set(requestRef, {
                inventoryId: request.inventoryId,
                itemCode: request.itemCode,
                itemName: request.itemName,
                location: request.location,
                currentQuantity: request.currentQuantity,
                requestedQuantity: request.requestedQuantity,
                adjustment: request.adjustment,
                reason: request.reason,
                status: 'pending',
                requestedBy: currentUser.uid,
                requestedByName: currentUser.name,
                requestDate: serverTimestamp(),
                timestamp: serverTimestamp(),
                source: 'excel'
            });
        }

        await batch.commit();

        showToast('Đã gửi yêu cầu chỉnh số từ Excel thành công!', 'success');
        bootstrap.Modal.getInstance(document.querySelector('.modal')).hide();
        loadAdjustRequests();

    } catch (error) {
        console.error('Error saving Excel requests:', error);
        showToast('Lỗi lưu yêu cầu chỉnh số từ Excel', 'danger');
    }
};

function initializeExcelFunctions() {
    // Sử dụng một trình lắng nghe ủy quyền duy nhất để có hiệu suất tốt hơn
    const contentArea = document.querySelector('main.col-md-9');
    if (!contentArea) return;

    contentArea.addEventListener('click', function(event) {
        const button = event.target.closest('button[id]');
        if (!button) return;

        // Ánh xạ ID của nút với hành động tương ứng
        const actions = {
            'downloadTemplate': () => downloadImportTemplate(),
            'importExcel': () => document.getElementById('excelFileInput')?.click(),
            'downloadExportTemplate': () => downloadExportTemplate(),
            'importExportExcel': () => document.getElementById('exportExcelFileInput')?.click(),
            'downloadTransferTemplate': () => downloadTransferTemplate(),
            'importTransferExcel': () => document.getElementById('transferExcelFileInput')?.click(),
            'downloadAdjustTemplate': () => downloadAdjustTemplate(),
            'importAdjustExcel': () => document.getElementById('adjustExcelFileInput')?.click(),
            'downloadRequestAdjustTemplate': () => downloadRequestAdjustTemplate(),
            'importRequestAdjustExcel': () => document.getElementById('requestAdjustExcelFileInput')?.click(),
        };

        // Thực thi hành động nếu nó tồn tại
        if (actions[button.id]) {
            event.preventDefault();
            actions[button.id]();
        }
    });

    // Các trình lắng nghe cho file input
    document.getElementById('excelFileInput')?.addEventListener('change', handleExcelImport);
    document.getElementById('exportExcelFileInput')?.addEventListener('change', handleExportExcelImport);
    document.getElementById('transferExcelFileInput')?.addEventListener('change', handleTransferExcelImport);
    document.getElementById('adjustExcelFileInput')?.addEventListener('change', handleAdjustExcelImport);
    document.getElementById('requestAdjustExcelFileInput')?.addEventListener('change', handleRequestAdjustExcelImport);
}

// Thêm vào file warehouse.js

let currentBarcodeItem = null;
let barcodeElementsLayout = {};
let savedTemplates = []; // Biến lưu các template
const INCH_TO_PX = 96;

// Thay thế hàm này trong warehouse.js
export function loadPrintBarcodeSection() {
    // Gán sự kiện cho các control cũ
    document.getElementById('barcodeItemSearch').addEventListener('input', debounce(searchItemsForBarcode, 300));
    document.getElementById('paperSizeSelector').addEventListener('change', updateBarcodeCanvasSize);
    document.getElementById('printBarcodeBtn').addEventListener('click', () => window.print());

    // Gán sự kiện cho các control Template
    document.getElementById('saveTemplateBtn').addEventListener('click', saveCurrentTemplate);
    document.getElementById('templateLoader').addEventListener('change', applySelectedTemplate);
    document.getElementById('deleteTemplateBtn').addEventListener('click', deleteSelectedTemplate);

    // THÊM MỚI: Gán sự kiện cho các ô nhập liệu tùy chỉnh
    document.getElementById('customWidthInput')?.addEventListener('input', debounce(updateBarcodeCanvasSize, 300));
    document.getElementById('customHeightInput')?.addEventListener('input', debounce(updateBarcodeCanvasSize, 300));

    // Tải các template đã lưu khi khởi tạo
    loadBarcodeTemplates();

    // Cập nhật kích thước canvas ban đầu
    updateBarcodeCanvasSize();
}


async function deleteSelectedTemplate() {
    const templateName = document.getElementById('templateLoader').value;
    if (!templateName) {
        showToast("Vui lòng chọn một mẫu để xóa.", "warning");
        return;
    }

    const templateToDelete = savedTemplates.find(t => t.name === templateName);
    if (!templateToDelete) return;

    const confirmed = await showConfirmation(
        'Xác nhận xóa mẫu',
        `Bạn có chắc muốn xóa vĩnh viễn mẫu tem "${templateName}"?`,
        'Xóa', 'Hủy', 'danger'
    );

    if (confirmed) {
        try {
            await deleteDoc(doc(db, "barcode_templates", templateToDelete.id));
            showToast(`Đã xóa mẫu "${templateName}".`, "success");
            
            // Tải lại danh sách từ đầu
            loadBarcodeTemplates();

        } catch (error) {
            console.error("Lỗi xóa mẫu tem:", error);
            showToast("Lỗi khi xóa mẫu tem trên máy chủ.", "danger");
        }
    }
}

// Thay thế hàm này trong warehouse.js
function applySelectedTemplate() {
    const templateName = document.getElementById('templateLoader').value;
    if (!templateName) return;

    const template = savedTemplates.find(t => t.name === templateName);
    if (template) {
        // Áp dụng kích thước giấy
        document.getElementById('paperSizeSelector').value = template.paperSize;

        // THÊM MỚI: Nếu là mẫu tùy chỉnh, điền giá trị vào các ô input
        if (template.paperSize === 'custom') {
            document.getElementById('customWidthInput').value = template.customWidth || 4;
            document.getElementById('customHeightInput').value = template.customHeight || 3;
        }

        // Cập nhật lại kích thước canvas (hàm này sẽ tự xử lý việc ẩn/hiện)
        updateBarcodeCanvasSize();
        
        // Áp dụng layout và hiển thị thông báo
        renderBarcodeLabel(template.layout);
        showToast(`Đã áp dụng mẫu "${templateName}".`, "info");
    }
}


// Thay thế hàm này trong warehouse.js
async function saveCurrentTemplate() {
    const templateName = document.getElementById('templateName').value.trim();
    if (!templateName) {
        showToast("Vui lòng đặt tên cho mẫu tem.", "warning");
        return;
    }

    if (savedTemplates.some(t => t.name === templateName)) {
        showToast("Tên mẫu này đã tồn tại. Vui lòng chọn tên khác.", "warning");
        return;
    }

    const currentLayout = {};
    document.querySelectorAll('.barcode-element').forEach(el => {
        currentLayout[el.dataset.key] = {
            top: el.offsetTop,
            left: el.offsetLeft
        };
    });

    // Tạo đối tượng template cơ bản
    const newTemplate = {
        name: templateName,
        paperSize: document.getElementById('paperSizeSelector').value,
        layout: currentLayout,
        userId: currentUser.uid,
        createdAt: serverTimestamp()
    };
    
    // THÊM MỚI: Nếu là kích thước tùy chỉnh, lưu lại giá trị width và height
    if (newTemplate.paperSize === 'custom') {
        newTemplate.customWidth = parseFloat(document.getElementById('customWidthInput').value) || 4;
        newTemplate.customHeight = parseFloat(document.getElementById('customHeightInput').value) || 3;
    }

    try {
        const docRef = await addDoc(collection(db, "barcode_templates"), newTemplate);
        showToast(`Đã lưu mẫu "${templateName}" thành công!`, "success");
        
        newTemplate.id = docRef.id;
        savedTemplates.push(newTemplate);
        populateTemplateSelector();

        document.getElementById('templateName').value = '';
        document.getElementById('templateLoader').value = newTemplate.name;

    } catch (error) {
        console.error("Lỗi lưu mẫu tem:", error);
        showToast("Lỗi khi lưu mẫu tem lên máy chủ.", "danger");
    }
}


async function loadBarcodeTemplates() {
    if (!currentUser) return;

    try {
        const q = query(collection(db, "barcode_templates"), where("userId", "==", currentUser.uid));
        const querySnapshot = await getDocs(q);
        
        savedTemplates = []; // Reset
        querySnapshot.forEach((doc) => {
            savedTemplates.push({ id: doc.id, ...doc.data() });
        });
        
        populateTemplateSelector();

    } catch (error) {
        console.error("Lỗi tải mẫu tem từ Firebase:", error);
        showToast("Không thể tải các mẫu tem đã lưu.", "danger");
    }
}

function populateTemplateSelector() {
    const loader = document.getElementById('templateLoader');
    loader.innerHTML = '<option value="">-- Chọn một mẫu --</option>'; 
    
    savedTemplates.forEach(template => {
        const option = document.createElement('option');
        option.value = template.name;
        option.textContent = template.name;
        loader.appendChild(option);
    });
}
// Thay thế hoàn toàn hàm searchItemsForBarcode() cũ bằng hàm này
async function searchItemsForBarcode(event) {
    const searchTerm = event.target.value.trim();
    const resultsContainer = document.getElementById('barcodeSearchResults');
    resultsContainer.innerHTML = '';

    if (searchTerm.length < 2) {
        return;
    }

    try {
        const upperCaseTerm = searchTerm.toUpperCase();
        
        // --- TẠO HAI TRUY VẤN SONG SONG ---

        // 1. Truy vấn theo MÃ HÀNG (rất hiệu quả và chính xác)
        const codeQuery = query(
            collection(db, 'inventory'),
            orderBy('code'), // Bắt buộc phải orderBy theo trường đang lọc phạm vi
            where('code', '>=', upperCaseTerm),
            where('code', '<=', upperCaseTerm + '\uf8ff'), // \uf8ff là ký tự Unicode cao để tạo giới hạn trên
            limit(5)
        );

        // 2. Truy vấn theo TÊN SẢN PHẨM (hiệu quả tương đối)
        // Lưu ý: Firestore không hỗ trợ tìm kiếm "contains" hoặc không phân biệt chữ hoa/thường một cách tự nhiên.
        // Cách này sẽ tìm các tên bắt đầu bằng chuỗi tìm kiếm.
        const nameQuery = query(
            collection(db, 'inventory'),
            orderBy('name'),
            where('name', '>=', searchTerm),
            where('name', '<=', searchTerm + '\uf8ff'),
            limit(5)
        );

        // --- THỰC THI CẢ HAI TRUY VẤN CÙNG LÚC ---
        const [codeSnapshot, nameSnapshot] = await Promise.all([
            getDocs(codeQuery),
            getDocs(nameQuery)
        ]);

        // --- GỘP KẾT QUẢ VÀ LOẠI BỎ TRÙNG LẶP ---
        const resultsMap = new Map();
        
        const processSnapshot = (snapshot) => {
            snapshot.forEach(doc => {
                // Dùng doc.id làm key để đảm bảo mỗi sản phẩm chỉ xuất hiện một lần
                if (!resultsMap.has(doc.id)) {
                    resultsMap.set(doc.id, { id: doc.id, ...doc.data() });
                }
            });
        };

        processSnapshot(codeSnapshot);
        processSnapshot(nameSnapshot);

        const finalResults = Array.from(resultsMap.values());

        // --- HIỂN THỊ KẾT QUẢ ---
        if (finalResults.length === 0) {
            resultsContainer.innerHTML = '<div class="list-group-item text-muted">Không tìm thấy sản phẩm phù hợp.</div>';
            return;
        }

        const resultsHtml = finalResults.map(item => {
            const itemJsonString = JSON.stringify(item).replace(/'/g, "\\'");
            return `<button type="button" class="list-group-item list-group-item-action" 
                    onclick='selectItemForBarcode(${itemJsonString})'>
                    <strong>${item.code}</strong> - ${item.name} (Tồn: ${item.quantity} | Vị trí: ${item.location})
                </button>`;
        }).join('');

        resultsContainer.innerHTML = `<div class="list-group mt-2">${resultsHtml}</div>`;

    } catch (error) {
        console.error("Lỗi tìm kiếm sản phẩm cho barcode:", error);
        resultsContainer.innerHTML = '<div class="list-group-item text-danger">Lỗi khi tìm kiếm. Vui lòng kiểm tra lại cấu hình Firestore.</div>';
    }
}


window.selectItemForBarcode = function(item) {
    currentBarcodeItem = item;
    
    // Dọn dẹp kết quả tìm kiếm sau khi đã chọn
    const resultsContainer = document.getElementById('barcodeSearchResults');
    if(resultsContainer) {
        resultsContainer.innerHTML = '';
    }
    
    document.getElementById('barcodeItemSearch').value = `${item.code} - ${item.name}`;
    
    const printBtn = document.getElementById('printBarcodeBtn');
    printBtn.disabled = false;

    if (userRole === 'staff') {
        printBtn.disabled = true;
        printBtn.title = 'Chỉ Admin trở lên mới có thể in tem';
    }
    
    renderBarcodeLabel();
}


function createScannedItemDetailsModal(item) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'scannedItemDetailsModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header bg-info text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-box-open"></i> Chi tiết tồn kho
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <h4 class="text-info">${item.name}</h4>
                    <div class="row">
                        <div class="col-6"><strong>Mã hàng:</strong></div>
                        <div class="col-6"><span class="badge bg-primary fs-6">${item.code}</span></div>
                    </div>
                    <hr class="my-2">
                    <div class="row">
                        <div class="col-6"><strong>Số lượng tồn:</strong></div>
                        <div class="col-6"><span class="badge bg-success fs-6">${item.quantity} ${item.unit}</span></div>
                    </div>
                    <hr class="my-2">
                    <div class="row">
                        <div class="col-6"><strong>Vị trí:</strong></div>
                        <div class="col-6"><span class="badge bg-secondary fs-6">${item.location}</span></div>
                    </div>
                     <hr class="my-2">
                    <div class="row">
                        <div class="col-6"><strong>Danh mục:</strong></div>
                        <div class="col-6">${item.category}</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    modal.addEventListener('hidden.bs.modal', () => modal.remove());
}
// Sửa đổi hàm renderBarcodeLabel trong warehouse.js
function renderBarcodeLabel(layout = null) {
    const canvas = document.getElementById('barcode-canvas');
    canvas.innerHTML = ''; 

    if (!currentBarcodeItem) return;

    // THAY ĐỔI LỚN: Định nghĩa lại layout mặc định của tem
    const defaultElements = {
        // Dòng 1: Mã hàng - Mô tả
        itemInfo: { 
            text: `${currentBarcodeItem.code} - ${currentBarcodeItem.name}`, 
            top: 5, 
            left: 5 
        },
        // Dòng 2: Số lượng - Vị trí
        stockInfo: { 
            text: `SL: ${currentBarcodeItem.quantity} - Vị trí: ${currentBarcodeItem.location}`, 
            top: 30, 
            left: 5 
        },
        // Dòng 3: Barcode
        barcode: { 
            type: 'barcode', 
            value: currentBarcodeItem.code, 
            top: 55, 
            left: 5, 
            width: 2, 
            height: 40 
        },
    };
    
    for (const key in defaultElements) {
        const defaultData = defaultElements[key];
        const pos = layout ? layout[key] : { top: defaultData.top, left: defaultData.left };

        const div = document.createElement('div');
        
        if (defaultData.type === 'barcode') {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = 'barcode-svg';
            div.appendChild(svg);
             JsBarcode(svg, defaultData.value, {
                width: defaultData.width,
                height: defaultData.height,
                displayValue: true // Tắt hiển thị text dưới barcode vì đã có ở dòng 1
            });
        } else {
             div.textContent = defaultData.text;
        }
       
        div.className = 'barcode-element';
        div.style.top = `${pos.top}px`;
        div.style.left = `${pos.left}px`;
        div.dataset.key = key; // Dùng key để lưu layout

        makeElementDraggable(div);
        canvas.appendChild(div);
    }
}

function makeElementDraggable(element) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    element.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

// Thay thế hàm này trong warehouse.js
function updateBarcodeCanvasSize() {
    const selector = document.getElementById('paperSizeSelector');
    const paperSize = selector.value;
    const canvas = document.getElementById('barcode-canvas');
    const customSizeContainer = document.getElementById('customSizeContainer');

    let widthInInches, heightInInches;

    // Hiển thị hoặc ẩn ô nhập liệu tùy chỉnh
    if (paperSize === 'custom') {
        customSizeContainer.style.display = 'flex'; // 'flex' để các cột nằm ngang
    } else {
        customSizeContainer.style.display = 'none';
    }

    // Lấy kích thước
    if (paperSize === 'custom') {
        widthInInches = parseFloat(document.getElementById('customWidthInput').value) || 4; // Mặc định là 4 nếu rỗng
        heightInInches = parseFloat(document.getElementById('customHeightInput').value) || 3; // Mặc định là 3 nếu rỗng
    } else {
        [widthInInches, heightInInches] = paperSize.split('x').map(Number);
    }

    // Áp dụng kích thước (chuyển từ inch sang pixel)
    canvas.style.width = `${widthInInches * INCH_TO_PX}px`;
    canvas.style.height = `${heightInInches * INCH_TO_PX}px`;

    // Vẽ lại barcode nếu có sản phẩm được chọn
    if (currentBarcodeItem) {
        renderBarcodeLabel();
    }
}

// Thêm vào file warehouse.js
let html5QrcodeScanner = null;

export function loadScanBarcodeSection() {
    document.getElementById('startScanBtn').onclick = startScanner;
    document.getElementById('stopScanBtn').onclick = stopScanner;
}

function startScanner() {
    // --- LOGIC "MỞ KHÓA" QUYỀN PHÁT ÂM THANH ---
    // Thử phát âm thanh và dừng ngay lập tức.
    // Hành động này đăng ký ý định của người dùng với trình duyệt.
    const playPromise = scannerBeep.play();
    if (playPromise !== undefined) {
        playPromise.then(_ => {
            scannerBeep.pause();
        }).catch(error => {
            // Đây là điều bình thường, trình duyệt đã chặn.
            console.log("Việc mở khóa âm thanh đã được trình duyệt xử lý.");
        });
    }
    // --- KẾT THÚC LOGIC MỞ KHÓA ---

    const scannerContainer = document.getElementById('barcode-scanner-container');
    scannerContainer.innerHTML = '';
    
    html5QrcodeScanner = new Html5Qrcode("barcode-scanner-container");

    const config = {
        fps: 10,
        qrbox: { width: 250, height: 250 }
    };
    
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        config,
        onScanSuccess,
        onScanFailure
    ).then(() => {
        document.getElementById('startScanBtn').style.display = 'none';
        document.getElementById('stopScanBtn').style.display = 'inline-block';
    }).catch(err => {
        showToast(`Không thể khởi động camera: ${err}`, 'danger');
    });
}

// Thay thế hoàn toàn hàm onScanSuccess() cũ bằng hàm này
async function onScanSuccess(decodedText, decodedResult) {
    stopScanner(); // Luôn dừng camera ngay khi có kết quả
    playScannerSound();
    
    try {
        const q = query(collection(db, 'inventory'), where('code', '==', decodedText));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            showToast(`Mã hàng "${decodedText}" không tồn tại!`, 'danger');
            return;
        }

        const itemsFromScan = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Kiểm tra xem một phiên xuất kho đã được bắt đầu hay chưa
        const isSessionActive = document.getElementById('scan-export-form');

        if (isSessionActive) {
            // Nếu đã có form, thêm sản phẩm vào danh sách hiện tại
            addItemToScanExportSession(itemsFromScan);
        } else {
            // Nếu chưa có, bắt đầu một phiên mới và tạo form
            startNewScanExportSession(itemsFromScan);
        }

    } catch (error) {
        console.error("Lỗi xử lý mã quét:", error);
        showToast('Lỗi truy vấn dữ liệu sản phẩm.', 'danger');
    }
}

function startNewScanExportSession(items) {
    // Reset danh sách mỗi khi bắt đầu phiên mới
    exportItemsList = []; 
    const scanResultContainer = document.getElementById('scanResultContainer');

    // Lấy sản phẩm ở vị trí có tồn kho nhiều nhất để thêm vào đầu tiên
    const itemToAdd = items.sort((a, b) => b.quantity - a.quantity)[0];
    if (itemToAdd.quantity <= 0) {
        showToast(`Sản phẩm "${itemToAdd.code}" đã hết hàng.`, 'warning');
        return;
    }

    // Thêm sản phẩm đầu tiên vào danh sách
    exportItemsList.push({
        inventoryId: itemToAdd.id,
        code: itemToAdd.code,
        name: itemToAdd.name,
        unit: itemToAdd.unit,
        location: itemToAdd.location,
        availableQuantity: itemToAdd.quantity,
        requestedQuantity: 1 
    });
    
    // Tạo và hiển thị form xuất kho
    renderScanExportForm();
    showToast(`Đã bắt đầu phiên xuất kho cho: ${itemToAdd.code}`, 'success');
}

// Thay thế hoàn toàn hàm renderScanExportForm() cũ bằng hàm này
function renderScanExportForm() {
    const scanResultContainer = document.getElementById('scanResultContainer');
    
    // Nút hành động dựa trên vai trò người dùng
    const actionButtonHtml = userRole === 'staff'
        ? `<button class="btn btn-primary w-100" onclick="finalizeExport()"><i class="fas fa-paper-plane"></i> Gửi yêu cầu xuất kho</button>`
        : `<button class="btn btn-warning w-100 text-dark" onclick="finalizeExport()"><i class="fas fa-check-circle"></i> Xác nhận & Xuất kho</button>`;

    scanResultContainer.innerHTML = `
        <div id="scan-export-form" class="scan-export-session-container">
            <!-- HEADER CHÍNH -->
            <div class="form-section-header-compact border-bottom pb-2 mb-3">
                <i class="fas fa-barcode text-warning"></i>
                <h5 class="mb-0">Phiếu Xuất Kho (từ mã quét)</h5>
            </div>

            <!-- FORM THÔNG TIN PHIẾU -->
            <div class="form-section-compact p-3">
                <div class="row g-2">
                    <div class="col-md-6">
                        <label class="form-label-compact">Số phiếu xuất *</label>
                        <input type="text" id="scanExportNumber" class="form-control-compact" placeholder="VD: PX-2024-01">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label-compact">Người nhận *</label>
                        <input type="text" id="scanExportRecipient" class="form-control-compact" placeholder="Tên hoặc bộ phận nhận">
                    </div>
                </div>
            </div>

            <!-- DANH SÁCH SẢN PHẨM -->
            <div class="form-section-compact mt-3 p-3">
                <div class="form-section-header-compact mb-2">
                    <i class="fas fa-list-ul"></i>
                    Danh sách sản phẩm
                    <span class="badge bg-warning text-dark ms-auto" id="scan-item-count-badge">0 mặt hàng</span>
                </div>
                <div class="table-responsive" style="max-height: 300px;">
                    <table class="table table-sm table-bordered table-hover">
                        <thead class="table-light">
                            <tr>
                                <th>Sản phẩm (Vị trí)</th>
                                <th style="width:120px;">SL Xuất</th>
                                <th style="width:50px;" class="text-center"><i class="fas fa-cog"></i></th>
                            </tr>
                        </thead>
                        <tbody id="scan-export-table-body">
                            <!-- Các dòng sản phẩm sẽ được thêm vào đây -->
                        </tbody>
                    </table>
                </div>
            </div>
            
            <!-- KHU VỰC HÀNH ĐỘNG -->
            <div class="mt-3 d-grid gap-2">
                ${actionButtonHtml}
                <button class="btn btn-outline-secondary" onclick="cancelScanExportSession()">
                    <i class="fas fa-times"></i> Hủy bỏ
                </button>
            </div>
        </div>
    `;

    // Vẽ danh sách sản phẩm và cập nhật bộ đếm
    renderScanExportTableBody();
}

function updateScanItemCount() {
    const badge = document.getElementById('scan-item-count-badge');
    if (badge) {
        badge.textContent = `${exportItemsList.length} mặt hàng`;
    }
}
function cancelScanExportSession() {
    exportItemsList = [];
    const scanResultContainer = document.getElementById('scanResultContainer');
    scanResultContainer.innerHTML = '<p class="text-muted">Chưa có kết quả. Vui lòng hướng camera vào mã vạch.</p>';
    showToast('Phiên xuất kho đã được hủy.', 'info');
}
function addItemToScanExportSession(items) {
    const itemToAdd = items.sort((a, b) => b.quantity - a.quantity)[0];
    if (itemToAdd.quantity <= 0) {
        showToast(`Sản phẩm "${itemToAdd.code}" đã hết hàng.`, 'warning');
        return;
    }

    // Kiểm tra xem sản phẩm đã có trong danh sách chưa
    const existingItemIndex = exportItemsList.findIndex(item => item.inventoryId === itemToAdd.id);

    if (existingItemIndex > -1) {
        // Nếu đã có, tăng số lượng lên 1 nếu chưa vượt tồn kho
        const itemInList = exportItemsList[existingItemIndex];
        if (itemInList.requestedQuantity < itemInList.availableQuantity) {
            itemInList.requestedQuantity++;
            showToast(`Đã cập nhật số lượng cho: ${itemToAdd.code}`, 'info');
        } else {
            showToast('Đã đạt số lượng tồn kho tối đa.', 'warning');
        }
    } else {
        // Nếu chưa có, thêm mới vào danh sách
        exportItemsList.push({
            inventoryId: itemToAdd.id,
            code: itemToAdd.code,
            name: itemToAdd.name,
            unit: itemToAdd.unit,
            location: itemToAdd.location,
            availableQuantity: itemToAdd.quantity,
            requestedQuantity: 1
        });
        showToast(`Đã thêm: ${itemToAdd.code}`, 'success');
    }

    // Cập nhật lại bảng danh sách sản phẩm
    renderScanExportTableBody();
}

// Thay thế hàm renderScanExportTableBody() cũ
function renderScanExportTableBody() {
    const tbody = document.getElementById('scan-export-table-body');
    if (!tbody) return;

    if (exportItemsList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted p-3">Chưa có sản phẩm nào.</td></tr>';
    } else {
        const tableHtml = exportItemsList.map((item, index) => `
            <tr>
                <td>
                    <strong>${item.code}</strong><br>
                    <small class="text-muted">${item.name} (${item.location})</small>
                </td>
                <td>
                    <input type="number" class="form-control form-control-sm" 
                           value="${item.requestedQuantity}" min="1" max="${item.availableQuantity}"
                           onchange="updateExportItemQuantity(${index}, this.value)">
                    <small class="text-muted">Tồn: ${item.availableQuantity}</small>
                </td>
                <td class="text-center align-middle">
                    <button class="btn btn-sm btn-outline-danger" onclick="removeExportItemFromList(${index})" title="Xóa">
                        <i class="fas fa-times"></i>
                    </button>
                </td>
            </tr>
        `).join('');

        tbody.innerHTML = tableHtml;
    }

    // Cập nhật lại bộ đếm số lượng
    updateScanItemCount();
}


function stopScanner() {
    if (html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
            document.getElementById('barcode-scanner-container').innerHTML = '';
            document.getElementById('startScanBtn').style.display = 'inline-block';
            document.getElementById('stopScanBtn').style.display = 'none';
        }).catch(err => {
            console.error("Lỗi khi dừng quét:", err);
        });
    }
}

const scannerBeep = new Audio('data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU3LjgyLjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlwAAAAA3ADh4aVo5QAFwAAAAA3ADh4aVo5QVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVahhhh//tAwAAAAADQBFwAAAAAADQBFwAAAAA');

function playScannerSound() {
    try {
        // Đảm bảo âm thanh có thể phát lại nhanh chóng nếu người dùng quét liên tục
        scannerBeep.currentTime = 0;
        scannerBeep.play();
    } catch (e) {
        console.error("Không thể phát âm thanh máy quét:", e);
    }
}



function showActionChoiceModal(items) {
    const item = items[0]; // Lấy thông tin chung từ sản phẩm đầu tiên
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">${item.name}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body text-center">
                    <p>Mã hàng: <strong>${item.code}</strong></p>
                    <p>Bạn muốn làm gì?</p>
                    <div class="d-grid gap-2">
                        <button class="btn btn-info" id="viewStockBtn">
                            <i class="fas fa-warehouse"></i> Xem tồn kho (${items.length} vị trí)
                        </button>
                        <button class="btn btn-secondary" id="viewHistoryBtn">
                            <i class="fas fa-history"></i> Xem lịch sử mã hàng
                        </button>
                        <button class="btn btn-warning" id="startExportBtn">
                            <i class="fas fa-upload"></i> Xuất kho
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    // Gán sự kiện cho các nút
    modal.querySelector('#viewStockBtn').onclick = () => {
        bsModal.hide();
        showMultiLocationStockModal(items);
    };
    modal.querySelector('#viewHistoryBtn').onclick = () => {
        bsModal.hide();
        viewItemHistoryFromScan(item.code);
    };
    modal.querySelector('#startExportBtn').onclick = () => {
        bsModal.hide();
        // Mở modal xuất kho và thêm sản phẩm đầu tiên vào
        showScanExportModal(items);
    };
    
    bsModal.show();
    modal.addEventListener('hidden.bs.modal', () => modal.remove());
}

function showMultiLocationStockModal(items) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    let stockHtml = items.map(item => `
        <tr>
            <td><strong>${item.location}</strong></td>
            <td class="text-end">${item.quantity}</td>
        </tr>
    `).join('');

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Tồn kho: ${items[0].name}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <table class="table">
                        <thead><tr><th>Vị trí</th><th class="text-end">Số lượng</th></tr></thead>
                        <tbody>${stockHtml}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    new bootstrap.Modal(modal).show();
    modal.addEventListener('hidden.bs.modal', () => modal.remove());
}

// Biến toàn cục để quản lý modal xuất kho
let currentExportModal = null; 
let exportItemsList = [];


window.updateExportItemQuantity = (index, newQty) => {
    const qty = parseInt(newQty);
    const item = exportItemsList[index];
    if (qty > 0 && qty <= item.availableQuantity) {
        item.requestedQuantity = qty;
    }
    renderExportListInModal();
};

window.removeExportItemFromList = (index) => {
    exportItemsList.splice(index, 1);
    renderExportListInModal();
};

// THAY THẾ TOÀN BỘ HÀM NÀY BẰNG PHIÊN BẢN MỚI
window.finalizeExport = async function() {
    if (exportItemsList.length === 0) {
        showToast('Danh sách xuất kho đang trống.', 'warning');
        return;
    }
    
    const exportNumber = document.getElementById('scanExportNumber')?.value.trim();
    const recipient = document.getElementById('scanExportRecipient')?.value.trim();

    if (!exportNumber || !recipient) {
        showToast('Vui lòng nhập Số phiếu xuất và Người nhận.', 'warning');
        return;
    }

    const actionText = userRole === 'staff' ? 'Gửi yêu cầu' : 'Xác nhận xuất kho';
    const confirmTitle = userRole === 'staff' ? 'Xác nhận Gửi Yêu cầu' : 'Xác nhận Xuất kho';
    const confirmType = userRole === 'staff' ? 'info' : 'warning';

    const confirmed = await showConfirmation(
        confirmTitle, `Bạn có chắc muốn ${actionText.toLowerCase()} cho <strong>${exportItemsList.length}</strong> mặt hàng?`,
        actionText, 'Hủy', confirmType
    );
    if (!confirmed) return;

    const itemsToSave = exportItemsList.map(item => ({
        inventoryId: item.inventoryId,
        code: item.code,
        name: item.name,
        unit: item.unit,
        location: item.location,
        quantity: item.requestedQuantity,
        availableQuantityBefore: item.availableQuantity
    }));

    if (userRole === 'staff') {
        try {
            await addDoc(collection(db, 'export_requests'), {
                requestedBy: currentUser.uid,
                requestedByName: currentUser.name,
                timestamp: serverTimestamp(),
                status: 'pending',
                exportNumber: exportNumber,
                recipient: recipient,
                items: itemsToSave
            });
            showToast('Đã gửi yêu cầu xuất kho thành công!', 'success');
            cancelScanExportSession();
        } catch (error) {
            console.error("Lỗi khi tạo yêu cầu xuất kho:", error);
            showToast('Đã xảy ra lỗi khi gửi yêu cầu.', 'danger');
        }
    } else {
        const batch = writeBatch(db);
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'export',
            exportNumber: exportNumber,
            recipient: recipient,
            items: itemsToSave,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp(),
            source: 'scan'
        });

        for (const item of itemsToSave) {
            const inventoryRef = doc(db, 'inventory', item.inventoryId);
            batch.update(inventoryRef, { quantity: increment(-item.quantity) });
        }

        try {
            await batch.commit();
            showToast('Xuất kho trực tiếp thành công!', 'success');
            cancelScanExportSession();
        } catch (error) {
            console.error("Lỗi khi xuất kho trực tiếp:", error);
            showToast('Lỗi khi cập nhật kho. Vui lòng thử lại.', 'danger');
        }
    }
};

window.loadApproveExportsSection = async function() {
    const content = document.getElementById('pendingExportsContent');
    content.innerHTML = '<p>Đang tải dữ liệu...</p>';

    try {
        const q = query(collection(db, 'export_requests'), where('status', '==', 'pending'), orderBy('timestamp', 'desc'));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            content.innerHTML = '<p class="text-muted">Không có yêu cầu xuất kho nào đang chờ duyệt.</p>';
            return;
        }

        let html = '<div class="list-group">';
        snapshot.forEach(doc => {
            const req = doc.data();
            const date = req.timestamp.toDate().toLocaleString('vi-VN');
            html += `
                <div class="list-group-item">
                    <div class="d-flex w-100 justify-content-between">
                        <h6 class="mb-1">Yêu cầu từ: ${req.requestedByName}</h6>
                        <small>${date}</small>
                    </div>
                    <p class="mb-1">Số lượng mặt hàng: ${req.items.length}</p>
                    <div>
                        <button class="btn btn-sm btn-primary" onclick="viewExportRequestDetails('${doc.id}')">Xem</button>
                        <button class="btn btn-sm btn-success" onclick="approveExportRequest('${doc.id}')">Duyệt</button>
                        <button class="btn btn-sm btn-danger" onclick="rejectExportRequest('${doc.id}')">Từ chối</button>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        content.innerHTML = html;
    } catch (error) {
        console.error("Lỗi tải yêu cầu xuất kho:", error);
        content.innerHTML = '<p class="text-danger">Lỗi tải dữ liệu.</p>';
    }
}

window.viewItemHistoryFromScan = async function(itemCode) {
    try {
        // Đóng modal chi tiết nếu có
        const modal = document.getElementById('scannedItemDetailsModal');
        if (modal) {
            const bsModal = bootstrap.Modal.getInstance(modal);
            if (bsModal) {
                bsModal.hide();
            }
        }

        // 1. CẬP NHẬT GIAO DIỆN BỘ LỌC TRƯỚC
        // Đặt giá trị mã hàng vào ô lọc của tab Lịch sử
        const historyItemCodeInput = document.getElementById('historyItemCodeFilter');
        if (historyItemCodeInput) {
            historyItemCodeInput.value = itemCode;
        }

        // 2. GỌI THẲNG HÀM TẢI DỮ LIỆU
        // Lấy tất cả các giá trị bộ lọc hiện tại từ giao diện và tải lại
        const currentFilters = {
            fromDate: document.getElementById('fromDate').value,
            toDate: document.getElementById('toDate').value,
            filterType: document.getElementById('historyFilter').value,
            itemCodeFilter: itemCode // Sử dụng mã hàng vừa quét
        };
        await loadAllHistory(currentFilters);

        // 3. CHUYỂN TAB SAU KHI DỮ LIỆU ĐÃ SẴN SÀNG
        // Kích hoạt sự kiện nhấn vào tab "Lịch sử" để điều hướng
        document.querySelector('a[data-section="history"]').click();
        
    } catch (error) {
        console.error("Lỗi khi xem lịch sử từ mã quét:", error);
        showToast("Không thể tải lịch sử cho mã hàng này.", "danger");
    }
}


function onScanFailure(error) {
    // Không làm gì để tránh log liên tục
}

window.viewInventoryDetailsFromScan = async function(inventoryId) {
    const docSnap = await getDoc(doc(db, 'inventory', inventoryId));
    if(docSnap.exists()){
        createScannedItemDetailsModal(docSnap.data());
    }
}

window.showImportFromScan = function(itemJson) {
    const item = JSON.parse(itemJson);
    showImportModal(); // Mở modal nhập kho
    
    // Đợi modal được tạo rồi điền thông tin
    setTimeout(() => {
        document.getElementById('newItemCode').value = item.code;
        document.getElementById('newItemName').value = item.name;
        document.getElementById('newItemUnit').value = item.unit;
        document.getElementById('newItemCategory').value = item.category;
        document.getElementById('newItemLocation').value = item.location;
        document.getElementById('newItemQuantity').focus();
    }, 500);
}

window.showExportFromScan = function(inventoryId, currentStock) {
    showExportModal(); // Mở modal xuất kho
    
    // Đợi modal được tạo rồi điền thông tin
    setTimeout(async () => {
        const docSnap = await getDoc(doc(db, 'inventory', inventoryId));
         if(docSnap.exists()){
            const item = docSnap.data();
            document.getElementById('exportItemCodeInput').value = item.code;
            document.getElementById('selectedExportInventoryId').value = inventoryId;
            document.getElementById('exportItemName').value = item.name;
            document.getElementById('exportItemName').dataset.unit = item.unit;
            document.getElementById('exportCurrentStock').value = currentStock;
            document.getElementById('exportQuantity').max = currentStock;
            document.getElementById('exportQuantity').focus();
         }
    }, 500);
}

// --- THÊM CÁC HÀM MỚI NÀY VÀO CUỐI TỆP WAREHOUSE.JS ---

/**
 * Mở modal để sửa thông tin cơ bản của một sản phẩm trong kho.
 * @param {object} item - Đối tượng sản phẩm đầy đủ, bao gồm cả id.
 */
window.editInventoryItem = function(item) {
    // Không cho phép sửa nếu không phải Super Admin
    if (userRole !== 'super_admin') {
        showToast('Bạn không có quyền thực hiện thao tác này.', 'danger');
        return;
    }

    const modal = createEditInventoryModal(item);
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
};

/**
 * Tạo HTML cho modal sửa thông tin sản phẩm.
 * @param {object} item - Đối tượng sản phẩm.
 * @returns {HTMLElement} - Phần tử DOM của modal.
 */
function createEditInventoryModal(item) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editInventoryModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header bg-warning text-dark">
                    <h5 class="modal-title"><i class="fas fa-edit"></i> Sửa thông tin sản phẩm</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-info">
                        <strong>Lưu ý:</strong> Bạn chỉ có thể sửa thông tin mô tả. Mã hàng và Số lượng không thể thay đổi tại đây. 
                        Để thay đổi số lượng, vui lòng sử dụng chức năng "Chỉnh số".
                    </div>
                    <form id="editInventoryForm">
                        <div class="mb-3">
                            <label class="form-label">Mã hàng (Không thể thay đổi)</label>
                            <input type="text" class="form-control" value="${item.code}" readonly>
                        </div>
                        <div class="mb-3">
                            <label for="editItemName" class="form-label">Tên mô tả</label>
                            <input type="text" class="form-control" id="editItemName" value="${item.name}">
                        </div>
                        <div class="row">
                            <div class="col-md-4">
                                <label for="editItemUnit" class="form-label">Đơn vị tính</label>
                                <input type="text" class="form-control" id="editItemUnit" value="${item.unit}">
                            </div>
                            <div class="col-md-4">
                                <label for="editItemCategory" class="form-label">Danh mục</label>
                                <input type="text" class="form-control" id="editItemCategory" value="${item.category}">
                            </div>
                            <div class="col-md-4">
                                <label for="editItemLocation" class="form-label">Vị trí</label>
                                <input type="text" class="form-control" id="editItemLocation" value="${item.location}">
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-warning" onclick="saveInventoryChanges('${item.id}')">Lưu thay đổi</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}

// THAY THẾ HÀM NÀY BẰNG PHIÊN BẢN MỚI

window.saveInventoryChanges = async function(itemId) {
    const newUpdateData = {
        name: document.getElementById('editItemName').value.trim(),
        unit: document.getElementById('editItemUnit').value.trim(),
        category: document.getElementById('editItemCategory').value.trim(),
        location: document.getElementById('editItemLocation').value.trim(),
    };

    if (!newUpdateData.name) {
        showToast('Tên mô tả không được để trống.', 'warning');
        return;
    }

    try {
        const itemRef = doc(db, 'inventory', itemId);
        
        // Lấy dữ liệu gốc TRƯỚC KHI cập nhật để so sánh
        const originalDoc = await getDoc(itemRef);
        const originalData = originalDoc.data();

        // Xây dựng đối tượng chỉ chứa những thay đổi thực sự
        const changes = {};
        if (originalData.name !== newUpdateData.name) changes.name = { from: originalData.name, to: newUpdateData.name };
        if (originalData.unit !== newUpdateData.unit) changes.unit = { from: originalData.unit, to: newUpdateData.unit };
        if (originalData.category !== newUpdateData.category) changes.category = { from: originalData.category, to: newUpdateData.category };
        if (originalData.location !== newUpdateData.location) changes.location = { from: originalData.location, to: newUpdateData.location };

        // Nếu không có gì thay đổi thì không làm gì cả
        if (Object.keys(changes).length === 0) {
            showToast('Không có thay đổi nào để lưu.', 'info');
            return;
        }

        // Sử dụng batch để đảm bảo cả hai hành động cùng thành công
        const batch = writeBatch(db);

        // 1. Cập nhật thông tin sản phẩm
        batch.update(itemRef, newUpdateData);

        // 2. Ghi lại lịch sử hành động
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'inventory_edited', // Loại giao dịch mới
            inventoryId: itemId,
            itemCode: originalData.code,
            changes: changes, // Chỉ lưu những gì đã thay đổi
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        
        showToast('Cập nhật thông tin sản phẩm thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editInventoryModal')).hide();
        
        if (window.loadInventoryTable) {
            window.loadInventoryTable(true, 1);
        }

    } catch (error) {
        console.error("Lỗi cập nhật sản phẩm:", error);
        showToast('Đã xảy ra lỗi khi cập nhật.', 'danger');
    }
};


// THAY THẾ HÀM NÀY BẰNG PHIÊN BẢN MỚI

window.deleteInventoryItem = async function(itemId, itemCode, quantity) {
    if (userRole !== 'super_admin') {
        showToast('Bạn không có quyền thực hiện thao tác này.', 'danger');
        return;
    }

    if (quantity > 0) {
        showToast(`Không thể xóa sản phẩm "${itemCode}" vì vẫn còn ${quantity} tồn kho.`, 'danger');
        return;
    }

    const confirmed = await showConfirmation(
        'Xác nhận xóa sản phẩm',
        `Bạn có chắc muốn XÓA (lưu trữ) sản phẩm <strong>${itemCode}</strong>? Sản phẩm sẽ bị ẩn khỏi danh sách tồn kho.`,
        'Xóa (lưu trữ)', 'Hủy', 'danger'
    );

    if (!confirmed) return;

    try {
        const itemRef = doc(db, 'inventory', itemId);
        const batch = writeBatch(db);

        // 1. Đánh dấu sản phẩm là đã lưu trữ
        batch.update(itemRef, {
            status: 'archived',
            deletedAt: serverTimestamp(),
            deletedBy: currentUser.uid,
            deletedByName: currentUser.name // Thêm thông tin người xóa
        });
        
        // 2. Ghi lại lịch sử hành động
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'inventory_archived', // Loại giao dịch mới
            inventoryId: itemId,
            itemCode: itemCode,
            details: `Sản phẩm ${itemCode} đã được xóa (lưu trữ).`,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast(`Đã xóa (lưu trữ) sản phẩm "${itemCode}" thành công.`, 'success');
        
        if (window.loadInventoryTable) {
            window.loadInventoryTable(true, 1);
        }

    } catch (error) {
        console.error("Lỗi xóa sản phẩm:", error);
        showToast('Đã xảy ra lỗi khi xóa sản phẩm.', 'danger');
    }
};

window.viewInventoryArchiveDetails = async function(transactionId) {
    const transSnap = await getDoc(doc(db, 'transactions', transactionId));
    if (!transSnap.exists()) return showToast('Không tìm thấy lịch sử.', 'danger');

    const data = transSnap.data();
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title"><i class="fas fa-archive"></i> Chi tiết Xóa Tồn Kho</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <p><strong>Mã hàng đã xóa (lưu trữ):</strong> ${data.itemCode}</p>
                    <p><strong>Người thực hiện:</strong> ${data.performedByName}</p>
                    <p><strong>Thời gian:</strong> ${data.timestamp.toDate().toLocaleString('vi-VN')}</p>
                    <div class="alert alert-danger mt-3">${data.details}</div>
                </div>
                <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    new bootstrap.Modal(modal).show();
    modal.addEventListener('hidden.bs.modal', () => modal.remove());
}