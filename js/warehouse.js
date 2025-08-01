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
    limit,
    onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

import { showToast } from './auth.js';
import { currentUser, userRole, companyInfo, layoutConfig } from './dashboard.js';

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
let currentExportItems = [];
let unsubscribeImportHistory = null;
let unsubscribeExportHistory = null;
let unsubscribeTransferHistory = null;
let unsubscribeAdjustHistory = null;
let unsubscribeAdjustRequests = null;
let unsubscribeAdjust = null;
let unsubscribeAllHistory = null;
let currentRequestItems = [];
const historyListeners = {
    import: null,
    export: null,
    transfer: null,
    adjust: null,
    all: null // Cho tab Lịch sử chung
};

// Biến lưu trữ dữ liệu và trang hiện tại của mỗi section
const sectionState = {
    import: { data: [], page: 1 },
    export: { data: [], page: 1 },
    transfer: { data: [], page: 1 },
    adjust: { data: [], page: 1 },
    all: { data: [], page: 1 },
};

const historyConfig = {
    import: {
        collection: 'transactions',
        baseConstraints: [where('type', '==', 'import')],
        filterIds: ['importFromDate', 'importToDate', 'importItemCodeFilter', 'importStatusFilter'],
        contentId: 'importContent',
        tableHeader: '<thead><tr class="text-center"><th>Số phiếu</th><th>Nhà cung cấp</th><th>Số mã hàng</th><th>Người thực hiện</th><th>Ngày nhập</th><th>Thao tác</th></tr></thead>',
        tableBodyId: 'importTableBody',
        paginationContainerId: 'importPaginationContainer',
        cols: 6,
        createRowFunc: createImportRow
    },
    export: {
        collection: 'transactions',
        baseConstraints: [where('type', '==', 'export')],
        filterIds: ['exportFromDate', 'exportToDate', 'exportItemCodeFilter'],
        contentId: 'exportContent',
        tableHeader: '<thead><tr class="text-center"><th>Số phiếu</th><th>Người nhận</th><th>Số mã hàng</th><th>Người thực hiện</th><th>Ngày xuất</th><th>Thao tác</th></tr></thead>',
        tableBodyId: 'exportTableBody',
        paginationContainerId: 'exportPaginationContainer',
        cols: 6,
        createRowFunc: createExportRow
    },
    transfer: {
        collection: 'transactions',
        baseConstraints: [where('type', '==', 'transfer')],
        filterIds: ['transferFromDate', 'transferToDate', 'transferItemCodeFilter'],
        contentId: 'transferContent',
        tableHeader: '<thead><tr class="text-center"><th>Mã hàng</th><th>Số lượng</th><th>Từ vị trí</th><th>Đến vị trí</th><th>Người thực hiện</th><th>Ngày chuyển</th><th>Thao tác</th></tr></thead>',
        tableBodyId: 'transferTableBody',
        paginationContainerId: 'transferPaginationContainer',
        cols: 7,
        createRowFunc: createTransferRow
    },
    adjust: {
        isComplex: true, // Đánh dấu đây là trường hợp đặc biệt
        contentId: 'adjustContent',
        tableHeader: '<thead><tr><th>Lý do / Nguồn gốc</th><th class="text-center">Số mã hàng</th><th class="text-center">Trạng thái</th><th>Người tạo / Xử lý</th><th>Ngày tạo / Xử lý</th><th class="text-center">Thao tác</th></tr></thead>',
        tableBodyId: 'adjustTableBody',
        paginationContainerId: 'adjustPaginationContainer',
        cols: 6,
        createRowFunc: createAdjustRow
    }
};

let itemCodeCache = new Map();
let unitCache = new Set(['Cái', 'Chiếc', 'Bộ', 'Hộp', 'Thùng', 'Cuộn', 'Tấm', 'Túi', 'Gói', 'Chai', 'Lọ', 'Lon', 'Bao', 'Kg', 'Gam', 'Tấn', 'Mét', 'Cây', 'Thanh', 'Đôi']);
let categoryCache = new Set();
const layoutSettingsModal = new bootstrap.Modal(document.getElementById('layoutSettingsModal'));

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
            if (data.status === 'archived') {
                return; // Bỏ qua mã hàng này
            }
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

// HÀM MỚI ĐÃ SỬA LỖI
export function initializeWarehouseFunctions() {
    if (listenersInitialized) return;

    document.body.addEventListener('click', function (event) {
        const target = event.target.closest('button');
        if (!target) return;
        switch (target.id) {
            case 'addImportBtn': showImportModal(); break;
            case 'addExportBtn': showExportModal(); break;
            case 'addTransferBtn': showTransferModal(); break;
        }
    });

    // THAY ĐỔI Ở ĐÂY: Gọi hàm mới đã được tái cấu trúc
    initializeAllFilterListeners();
    initializeExcelFunctions();
    
    listenersInitialized = true;
}

// Import Section Functions
export function loadImportSection() {
    initializeRealtimeHistoryTable('import');
}

/**
 * Gán sự kiện cho tất cả các bộ lọc một lần duy nhất.
 */
function initializeAllFilterListeners() {
    // Cờ để đảm bảo hàm chỉ chạy một lần
    if (window.allFiltersInitialized) return;

    // Lặp qua tất cả các mục trong cấu hình (import, export, transfer, adjust)
    Object.keys(historyConfig).forEach(sectionName => {
        const config = historyConfig[sectionName];
        
        // Tạo một hàm xử lý chung cho bộ lọc của section này
        const handler = () => {
            // Khi lọc, luôn quay về trang đầu tiên
            sectionState[sectionName].page = 1; 
            renderPaginatedHistoryTable(sectionName);
        };

        // Gán sự kiện cho từng ID filter được định nghĩa trong config
        config.filterIds?.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                // Sử dụng sự kiện 'input' cho ô text, 'change' cho các loại khác
                const eventType = element.type === 'text' ? 'input' : 'change';
                
                // Nếu là ô text, dùng debounce để tránh gọi liên tục
                const listener = eventType === 'input' ? debounce(handler, 500) : handler;
                
                element.addEventListener(eventType, listener);
            }
        });
    });
    
    // Đánh dấu là đã khởi tạo xong
    window.allFiltersInitialized = true;
}

function showImportModal() {
    const lastFocusedElement = document.activeElement;
    currentImportItems = []; // Reset danh sách hàng hóa mỗi khi mở

    const modal = createImportModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        document.getElementById('importNumber').focus(); // Tự động focus vào ô nhập liệu đầu tiên
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

    // Tạo các option cho Dãy, Kệ, Tầng
    const aisleOptions = layoutConfig.aisles.map(a => `<option value="${a}">${a}</option>`).join('');
    let bayOptions = '';
    for (let i = 1; i <= layoutConfig.maxBay; i++) {
        bayOptions += `<option value="${i}">Kệ ${i}</option>`;
    }
    let levelOptions = '';
    for (let i = 1; i <= layoutConfig.maxLevel; i++) {
        levelOptions += `<option value="${i}">Tầng ${i}</option>`;
    }

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-success text-white">
                    <h5 class="modal-title"><i class="fas fa-download"></i> Tạo phiếu nhập kho</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="importForm" onsubmit="return false;">
                        <!-- THÔNG TIN PHIẾU -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-file-alt"></i> Thông tin phiếu nhập
                            </div>
                            <div class="row">
                                <div class="col-md-6"><div class="form-group-compact">
                                    <label class="form-label-compact"><i class="fas fa-hashtag text-primary"></i> Số phiếu nhập <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control-compact" id="importNumber" required>
                                </div></div>
                                <div class="col-md-6"><div class="form-group-compact">
                                    <label class="form-label-compact"><i class="fas fa-truck text-primary"></i> Nhà cung cấp <span class="text-danger">*</span></label>
                                    <input type="text" class="form-control-compact" id="supplier" required>
                                </div></div>
                            </div>
                        </div>

                        <!-- THÊM mã hàng - VERSION GỌN GÀNG -->
                        <div class="form-section-compact form-section-collapsible" id="addItemSection">
                            <div class="form-section-header-compact">
                                <i class="fas fa-plus-circle"></i> Thêm mã hàng
                                <button type="button" class="collapse-toggle" onclick="toggleAddItemSection()"><i class="fas fa-chevron-up" id="collapseIcon"></i> Thu gọn</button>
                            </div>
                            <div class="form-section-body">
                                <div class="row quick-add-row mb-2 g-2">
                                    <div class="col-md-3"><label class="form-label-compact"><i class="fas fa-barcode text-primary"></i> Mã hàng *</label><div class="autocomplete-container-compact"><input type="text" class="form-control-compact" id="newItemCode" placeholder="Mã hàng..." autocomplete="off"><div class="suggestion-dropdown-compact" id="itemCodeSuggestions" style="display: none;"></div></div><div id="itemStatus"></div></div>
                                    <div class="col-md-3"><label class="form-label-compact"><i class="fas fa-tag text-primary"></i> Tên mô tả *</label><input type="text" class="form-control-compact" id="newItemName" placeholder="Tên mã hàng..." required></div>
                                    <div class="col-md-2"><label class="form-label-compact"><i class="fas fa-sort-numeric-up text-primary"></i> SL *</label><input type="number" class="form-control-compact" id="newItemQuantity" placeholder="0" required min="1" step="1"></div>
                                    <div class="col-md-2"><label class="form-label-compact"><i class="fas fa-ruler text-primary"></i> Đơn vị *</label><select class="form-select-compact" id="newItemUnit" required></select></div>
                                    <div class="col-md-2"><label class="form-label-compact"><i class="fas fa-list text-primary"></i> Danh mục *</label><div class="autocomplete-container-compact"><input type="text" class="form-control-compact" id="newItemCategory" placeholder="Danh mục..." required autocomplete="off"><div class="suggestion-dropdown-compact" id="categorySuggestions" style="display: none;"></div></div></div>
                                    
                                    <!-- === THAY ĐỔI VỊ TRÍ === -->
                                    <div class="col-md-9"><label class="form-label-compact"><i class="fas fa-map-marker-alt text-primary"></i> Vị trí *</label>
                                        <div class="row">
                                            <div class="col-md-3">
                                            <small class="form-label">Chọn dãy</small>
                                                <select class="form-select-compact" id="newItemAisle">${aisleOptions}</select>
                                            </div>
                                            <div class="col-md-3">
                                            <small class="form-label">Chọn kệ</small>
                                                <select class="form-select-compact" id="newItemBay">${bayOptions}</select>
                                            </div>
                                            <div class="col-md-3">
                                            <small class="form-label">Chọn tầng</small>
                                                <select class="form-select-compact" id="newItemLevel">${levelOptions}</select>
                                            </div>
                                        </div>
                                    </div>
                                    <!-- === KẾT THÚC THAY ĐỔI VỊ TRÍ === -->

                                </div>
                                <div class="row align-items-end mt-2">
                                    <div class="col-md-3"><div class="d-flex gap-1"><button type="button" class="add-unit-btn" onclick="toggleCustomUnitInput()" title="Thêm đơn vị mới"><i class="fas fa-plus"></i> Đơn vị</button><div class="custom-unit-container" id="customUnitContainer" style="display: none;"><input type="text" class="form-control-compact" id="customUnitInput" placeholder="Đơn vị mới..." maxlength="20" style="width: 80px;"><button type="button" class="btn btn-sm btn-success" onclick="addCustomUnit()" style="height: 32px;"><i class="fas fa-check"></i></button></div></div></div>
                                    <div class="col-md-6"><small class="text-muted"><i class="fas fa-lightbulb"></i> Nhập mã hàng để tự động điền thông tin có sẵn</small></div>
                                    <div class="col-md-3 text-end"><button type="button" class="btn btn-primary btn-sm" onclick="addItemToImportList()"><i class="fas fa-plus"></i> Thêm vào danh sách</button></div>
                                </div>
                            </div>
                        </div>

                        <!-- DANH SÁCH HÀNG HÓA -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact"><i class="fas fa-list-ul"></i> Danh sách hàng hóa nhập kho<span class="badge bg-primary ms-auto" id="itemCountBadge">0 mã hàng</span></div>
                            <div class="table-responsive"><table class="table table-bordered table-compact"><thead class="table-success"><tr class="text-center"><th style="width: 12%">Mã hàng</th><th style="width: 25%">Tên mô tả</th><th style="width: 12%">SL</th><th style="width: 12%">Đơn vị</th><th style="width: 12%">Danh mục</th><th style="width: 12%">Vị trí</th><th style="width: 15%">Thao tác</th></tr></thead><tbody id="importItemsTable"><tr id="emptyTableRow"><td colspan="7" class="text-center text-muted py-3"><i class="fas fa-inbox fa-lg mb-1"></i><br><small>Chưa có mã hàng nào.</small></td></tr></tbody></table></div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal"><i class="fas fa-times"></i> Hủy</button>
                    <button type="button" class="btn btn-success" onclick="saveImport()" id="saveImportBtn" disabled><i class="fas fa-save"></i> Lưu phiếu nhập</button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        setupImportModalEventListeners();
    }, 0);

    return modal;
}

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

function autoCollapseAfterAdd() {
    const section = document.getElementById('addItemSection');
    if (section && !section.classList.contains('collapsed')) {
        setTimeout(() => {
            toggleAddItemSection();
        }, 500);
    }
}

function updateTableBody(tableBodyId, rows, emptyMessage, colspan) {
    const tbody = document.getElementById(tableBodyId);
    if (!tbody) return;

    // Xóa nội dung cũ
    while (tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
    }

    if (rows.length > 0) {
        rows.forEach(row => tbody.appendChild(row));
    } else {
        tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-center text-muted p-4">${emptyMessage}</td></tr>`;
    }
}

function setupImportModalEventListeners() {
    document.getElementById('importNumber')?.addEventListener('input', updateSaveButtonState);
    document.getElementById('supplier')?.addEventListener('input', updateSaveButtonState);
    document.getElementById('newItemCode')?.addEventListener('input', handleItemCodeAutocomplete);
    document.getElementById('newItemCode')?.addEventListener('blur', () => setTimeout(() => hideSuggestions('itemCodeSuggestions'), 200));
    document.getElementById('newItemCategory')?.addEventListener('input', handleCategoryAutocomplete);
    document.getElementById('newItemCategory')?.addEventListener('blur', () => setTimeout(() => hideSuggestions('categorySuggestions'), 200));
    loadUnitsIntoSelector();
    suggestImportNumber();
}

function updateSaveButtonState() {
    const saveBtn = document.getElementById('saveImportBtn');
    if (!saveBtn) return;
    const hasBasicInfo = document.getElementById('importNumber').value.trim() &&
        document.getElementById('supplier').value.trim();
    saveBtn.disabled = !hasBasicInfo;
}

function suggestImportNumber() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = today.toTimeString().slice(0, 5).replace(':', '');
    const suggested = `NK${dateStr}${timeStr}`;
    document.getElementById('importNumber').placeholder = `Gợi ý: ${suggested}`;
}

export function hideSuggestions(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (dropdown) dropdown.style.display = 'none';
}

function loadUnitsIntoSelector() {
    const unitSelect = document.getElementById('newItemUnit');
    if (!unitSelect) return;
    unitSelect.innerHTML = '<option value="">-- Chọn --</option>';
    Array.from(unitCache).sort().forEach(unit => {
        const option = new Option(unit, unit);
        unitSelect.appendChild(option);
    });
}

window.addCustomUnit = function () {
    const input = document.getElementById('customUnitInput');
    const newUnit = input.value.trim();
    if (!newUnit) return showToast('Vui lòng nhập tên đơn vị', 'warning');
    if (unitCache.has(newUnit)) return showToast('Đơn vị này đã tồn tại', 'warning');
    unitCache.add(newUnit);
    loadUnitsIntoSelector();
    document.getElementById('newItemUnit').value = newUnit;
    input.value = '';
    document.getElementById('customUnitContainer').style.display = 'none';
    showToast(`Đã thêm đơn vị "${newUnit}"`, 'success');
};

window.addItemToImportList = function () {
    // Lấy giá trị từ 3 ô chọn vị trí
    const aisle = document.getElementById('newItemAisle').value;
    const bay = document.getElementById('newItemBay').value;
    const level = document.getElementById('newItemLevel').value;

    if (!aisle || !bay || !level) {
        return showToast('Vui lòng chọn đầy đủ thông tin vị trí (Dãy, Kệ, Tầng).', 'warning');
    }

    // Tạo chuỗi vị trí hoàn chỉnh
    const locationString = `${aisle}${bay}-${level.toString().padStart(2, '0')}`;

    const item = {
        code: document.getElementById('newItemCode').value.trim(),
        name: document.getElementById('newItemName').value.trim(),
        quantity: parseInt(document.getElementById('newItemQuantity').value),
        unit: document.getElementById('newItemUnit').value,
        category: document.getElementById('newItemCategory').value.trim(),
        location: locationString // Sử dụng chuỗi vị trí mới
    };

    if (Object.values(item).some(v => !v) || item.quantity <= 0) {
        return showToast('Vui lòng điền đầy đủ thông tin hợp lệ', 'warning');
    }
    const existingIndex = currentImportItems.findIndex(i => i.code === item.code && i.location === item.location);
    if (existingIndex >= 0) {
        currentImportItems[existingIndex].quantity += item.quantity;
    } else {
        currentImportItems.push(item);
    }
    if (!itemCodeCache.has(item.code)) itemCodeCache.set(item.code, { ...item });
    categoryCache.add(item.category);
    unitCache.add(item.unit);
    updateImportItemsTable();
    clearImportForm();
    updateSaveButtonState();
    autoCollapseAfterAdd();
    showToast(`Đã thêm "${item.name}"`, 'success');
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
    if (!isVisible) document.getElementById('customUnitInput').focus();
};

function handleCategoryAutocomplete(event) {
    const value = event.target.value.trim();
    if (value.length === 0) return hideSuggestions('categorySuggestions');
    const suggestions = Array.from(categoryCache).filter(cat => cat.toLowerCase().includes(value.toLowerCase())).slice(0, 5);
    if (suggestions.length > 0) showCategorySuggestions(suggestions);
    else hideSuggestions('categorySuggestions');
}

window.selectCategory = function (category) {
    document.getElementById('newItemCategory').value = category;
    hideSuggestions('categorySuggestions');
};

function showCategorySuggestions(suggestions) {
    const dropdown = document.getElementById('categorySuggestions');
    dropdown.innerHTML = suggestions.map(cat => `<div class="suggestion-item-compact" onclick="selectCategory('${cat}')">${cat}</div>`).join('');
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
    if (itemCodeCache.has(value)) {
        fillItemFields(itemCodeCache.get(value));
        updateItemStatus('existing', `Mã đã tồn tại: ${itemCodeCache.get(value).name}`);
        hideSuggestions('itemCodeSuggestions');
        return;
    }
    const suggestions = Array.from(itemCodeCache.keys()).filter(code => code.includes(value)).slice(0, 5);
    if (suggestions.length > 0) showItemCodeSuggestions(suggestions);
    else {
        hideSuggestions('itemCodeSuggestions');
        clearItemFields();
        updateItemStatus('new', 'Mã hàng mới - sẽ được tạo');
    }
}

function clearItemFields() {
    document.getElementById('newItemName').value = '';
    document.getElementById('newItemCategory').value = '';
    document.getElementById('newItemAisle').selectedIndex = 0;
    document.getElementById('newItemBay').selectedIndex = 0;
    document.getElementById('newItemLevel').selectedIndex = 0;
    document.getElementById('newItemUnit').value = '';
}

function showItemCodeSuggestions(suggestions) {
    const dropdown = document.getElementById('itemCodeSuggestions');
    dropdown.innerHTML = suggestions.map(code => {
        const item = itemCodeCache.get(code);
        return `<div class="suggestion-item-compact" onclick="selectItemCode('${code}')"><strong>${code}</strong> - ${item.name}</div>`;
    }).join('');
    dropdown.style.display = 'block';
}

window.selectItemCode = function (code) {
    document.getElementById('newItemCode').value = code;
    fillItemFields(itemCodeCache.get(code));
    updateItemStatus('existing', `Mã đã tồn tại: ${itemCodeCache.get(code).name}`);
    hideSuggestions('itemCodeSuggestions');
    document.getElementById('newItemQuantity').focus();
};

function updateItemStatus(type, message) {
    const statusDiv = document.getElementById('itemStatus');
    if (!type) return statusDiv.innerHTML = '';
    const iconMap = { 'existing': 'fas fa-info-circle', 'new': 'fas fa-plus-circle' };
    const classMap = { 'existing': 'status-existing', 'new': 'status-new' };
    statusDiv.innerHTML = `<div class="status-indicator-compact ${classMap[type]}"><i class="${iconMap[type]}"></i> ${message}</div>`;
}

function fillItemFields(itemData) {
    document.getElementById('newItemName').value = itemData.name;
    document.getElementById('newItemCategory').value = itemData.category;
    if (itemData.unit && !unitCache.has(itemData.unit)) {
        unitCache.add(itemData.unit);
        loadUnitsIntoSelector();
    }
    document.getElementById('newItemUnit').value = itemData.unit;
    const locationRegex = /^([A-Z])(\d+)-(\d+)$/;
    const match = itemData.location.match(locationRegex);

    if (match) {
        // match[1] là Dãy (A), match[2] là Kệ (1), match[3] là Tầng (02)
        const aisle = match[1];
        const bay = parseInt(match[2], 10);
        const level = parseInt(match[3], 10);

        // Đặt giá trị cho từng ô dropdown
        document.getElementById('newItemAisle').value = aisle;
        document.getElementById('newItemBay').value = bay;
        document.getElementById('newItemLevel').value = level;
    }
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

function updateImportItemsTable() {
    const tbody = document.getElementById('importItemsTable');
    const emptyRow = document.getElementById('emptyTableRow');
    if (currentImportItems.length === 0) {
        emptyRow.style.display = '';
        tbody.querySelectorAll('tr:not(#emptyTableRow)').forEach(row => row.remove());
    } else {
        emptyRow.style.display = 'none';
        tbody.querySelectorAll('tr:not(#emptyTableRow)').forEach(row => row.remove());
        currentImportItems.forEach((item, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="text-center"><strong>${item.code}</strong></td>
                <td>${item.name}</td>
                <td class="text-center"><span class="badge bg-primary">${item.quantity}</span></td>
                <td class="text-center">${item.unit}</td>
                <td class="text-center">${item.category}</td>
                <td class="text-center"><span class="badge bg-secondary">${item.location}</span></td>
                <td class="text-center">
                    <button class="btn btn-warning btn-sm me-1" onclick="editImportItem(${index})"><i class="fas fa-edit"></i> Sửa</button>
                    <button class="btn btn-danger btn-sm" onclick="removeImportItem(${index})"><i class="fas fa-trash"></i> Xóa</button>
                </td>
            `;
            tbody.appendChild(row);
        });
    }
    document.getElementById('itemCountBadge').textContent = `${currentImportItems.length} mã hàng`;
}

window.editImportItem = function (index) {
    const item = currentImportItems[index];
    document.getElementById('newItemCode').value = item.code;
    document.getElementById('newItemName').value = item.name;
    document.getElementById('newItemQuantity').value = item.quantity;
    document.getElementById('newItemUnit').value = item.unit;
    document.getElementById('newItemCategory').value = item.category;
    document.getElementById('newItemLocation').value = item.location;
    updateItemStatus('existing', `Đang chỉnh sửa: ${item.name}`);
    currentImportItems.splice(index, 1);
    updateImportItemsTable();
    updateSaveButtonState();
    const section = document.getElementById('addItemSection');
    if (section && section.classList.contains('collapsed')) {
        toggleAddItemSection();
    }
    document.getElementById('newItemQuantity').focus();
    document.getElementById('newItemQuantity').select();
};

window.removeImportItem = async function (index) {
    const item = currentImportItems[index];
    const confirmed = await showConfirmation('Xóa mã hàng', `Bạn có chắc muốn xóa "${item.name}"?`, 'Xóa', 'Hủy', 'danger');
    if (confirmed) {
        currentImportItems.splice(index, 1);
        updateImportItemsTable();
        updateSaveButtonState();
        showToast(`Đã xóa "${item.name}"`, 'success');
    }
};

window.saveImport = async function () {
    if (currentImportItems.length === 0) {
        return showToast('Vui lòng thêm ít nhất một mã hàng', 'warning');
    }
    const importNumber = document.getElementById('importNumber').value;
    const supplier = document.getElementById('supplier').value;
    if (!importNumber || !supplier) {
        return showToast('Vui lòng điền đầy đủ thông tin phiếu nhập', 'warning');
    }
    try {
        const batch = writeBatch(db);
        const itemsWithQcStatus = currentImportItems.map(item => ({ ...item, qc_status: 'pending' }));
        const importDoc = doc(collection(db, 'transactions'));
        batch.set(importDoc, {
            type: 'import',
            importNumber: importNumber,
            supplier: supplier,
            items: itemsWithQcStatus,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });
        await batch.commit();
        showToast('Tạo phiếu nhập thành công! Phiếu đang chờ QC.', 'success');
        const importModal = document.getElementById('importModal');
        if (importModal) {
            bootstrap.Modal.getInstance(importModal).hide();
        }
    } catch (error) {
        console.error('Lỗi khi lưu phiếu nhập:', error);
        showToast('Lỗi lưu phiếu nhập', 'danger');
    }
};

function downloadImportTemplate() {
    const data = [
        // THAY ĐỔI: Thêm cột 'Vị trí'
        ['Mã hàng', 'Tên mô tả', 'Số lượng', 'Đơn vị tính', 'Danh mục', 'Vị trí'],
        ['SP-NEW-01', 'Mã hàng mới hoàn toàn', '100', 'Cái', 'Hàng mới', 'C1-01'],
        ['SP-EXIST-01', 'Mã hàng đã có tại A1-05', '50', 'Hộp', 'Hàng tiêu dùng', 'A1-05']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    // THAY ĐỔI: Cập nhật độ rộng cột
    ws['!cols'] = [{ wch: 15 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 20 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Nhap_Kho');
    XLSX.writeFile(wb, 'mau-nhap-kho.xlsx');
}

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

            // THAY ĐỔI: Đọc 6 cột và thêm 'location'
            const items = data.slice(1).filter(row => row.length >= 6 && row[0]).map(row => ({
                code: row[0]?.toString().trim() || '',
                name: row[1]?.toString().trim() || '',
                quantity: parseInt(row[2]) || 0,
                unit: row[3]?.toString().trim() || '',
                category: row[4]?.toString().trim() || '',
                location: row[5]?.toString().trim() || '' // Thêm vị trí
            }));

            if (items.length > 0) {
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
 * @param {Array} items - Danh sách mã hàng từ file Excel.
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
                                <tr class="text-center">
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
        let status = '';
        let tooltip = ''; // Biến để chứa tooltip thông báo

        // SỬA ĐỔI: Logic cốt lõi nằm ở đây
        // 1. Kiểm tra nếu mã hàng đã có trong bộ nhớ đệm (database)
        if (itemCodeCache.has(item.code)) {
            const existingData = itemCodeCache.get(item.code);
            
            // 2. Ghi đè thông tin từ Excel bằng dữ liệu cũ để đảm bảo nhất quán
            item.name = existingData.name;
            item.unit = existingData.unit;
            item.category = existingData.category;
            
            status = 'existing_updated';
            // 3. Hiển thị một huy hiệu khác để người dùng biết dữ liệu đã được tự động sửa
            statusBadge = `<span class="badge bg-info text-dark">Tồn tại</span>`;
            tooltip = `data-bs-toggle="tooltip" title="Tên, ĐVT, Danh mục được tự động cập nhật theo dữ liệu hiện có."`;
        }

        // 4. Tiếp tục các bước kiểm tra như cũ
        if (!item.code || !item.name || !item.unit || !item.category || !item.location) {
            statusBadge = `<span class="badge bg-danger">Lỗi - Thiếu thông tin</span>`;
            itemIsValid = false;
            row.classList.add('table-danger');
        } else if (item.quantity <= 0) {
            statusBadge = `<span class="badge bg-warning text-dark">Lỗi - SL không hợp lệ</span>`;
            itemIsValid = false;
            row.classList.add('table-warning');
        } else if (status !== 'existing_updated') {
            // Nếu là mã mới, kiểm tra xem nó đã có ở đúng vị trí đó chưa
             try {
                const inventoryQuery = query(
                    collection(db, 'inventory'),
                    where('code', '==', item.code),
                    where('location', '==', item.location),
                    limit(1)
                );
                const snapshot = await getDocs(inventoryQuery);

                if (snapshot.empty) {
                    status = 'new';
                    statusBadge = `<span class="badge bg-primary">Mới</span>`;
                } else {
                    status = 'existing';
                    statusBadge = `<span class="badge bg-info">Tồn tại</span>`;
                }
            } catch (error) {
                console.error("Error checking item:", item.code, error);
                statusBadge = `<span class="badge bg-danger">Lỗi kiểm tra</span>`;
                itemIsValid = false;
                row.classList.add('table-danger');
            }
        }
        
        // Cập nhật lại màu sắc cho dòng dựa trên trạng thái cuối cùng
        if (status === 'new') row.classList.add('table-primary', 'bg-opacity-10');
        if (status === 'existing' || status === 'existing_updated') row.classList.add('table-info', 'bg-opacity-10');


        // 5. Hiển thị dòng với dữ liệu đã được sửa (nếu có)
        row.innerHTML = `
            <td class="text-center">${item.code}</td>
            <td>${item.name}</td>
            <td class="text-center">${item.quantity}</td>
            <td class="text-center">${item.unit}</td>
            <td class="text-center">${item.category}</td>
            <td class="text-center">${item.location}</td>
            <td class="text-center" ${tooltip}>${statusBadge}</td>
        `;
        tbody.appendChild(row);

        if (!itemIsValid) {
            allValid = false;
        } else {
            validatedItems.push({ ...item, status: status });
        }
    }

    saveBtn.disabled = !allValid || validatedItems.length === 0;
    window.validatedImportItems = validatedItems;

    // Kích hoạt tooltip cho các dòng được cập nhật
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
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
        showToast('Không có mã hàng hợp lệ để nhập kho', 'warning');
        return;
    }

    try {
        const batch = writeBatch(db);
        const itemsWithQcStatus = itemsToImport.map(item => ({
            code: item.code,
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            category: item.category,
            location: item.location,
            qc_status: 'pending'
        }));

        // BƯỚC 2: Chỉ tạo một bản ghi giao dịch duy nhất
        const importDocRef = doc(collection(db, 'transactions'));
        batch.set(importDocRef, {
            type: 'import',
            importNumber: importNumber,
            supplier: supplier,
            items: itemsWithQcStatus,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp(),
            source: 'excel'
        });

        await batch.commit();

        // **FIX:** Cập nhật thông báo thành công cho đúng quy trình
        showToast('Tạo phiếu nhập từ Excel thành công! Phiếu đang chờ QC.', 'success');

        const modal = document.getElementById('importExcelPreviewModal');
        if (modal) {
            bootstrap.Modal.getInstance(modal).hide();
        }

    } catch (error) {
        console.error('Lỗi khi lưu phiếu nhập từ Excel:', error);
        showToast('Lỗi lưu phiếu nhập từ Excel', 'danger');
    }
};

// Thay thế hàm này trong warehouse.js
window.viewImportDetails = async function (transactionId) {
    try {
        const existingModal = document.querySelector('#importDetailsModal');
        if (existingModal) {
            bootstrap.Modal.getInstance(existingModal)?.hide();
        }

        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu nhập', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createImportDetailsModal(transactionId, data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);

        // *** FIX: Lắng nghe sự kiện khi modal được đóng ***
        // Khi người dùng đóng modal này, nó sẽ tự động tải lại bảng lịch sử nhập kho
        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove(); // Dọn dẹp modal khỏi DOM
        }, { once: true });

        bsModal.show();

    } catch (error) {
        console.error('Lỗi tải chi tiết phiếu nhập:', error);
        showToast('Lỗi tải chi tiết phiếu nhập', 'danger');
    }
};

function createImportDetailsModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.id = 'importDetailsModal';
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const totalItems = data.items?.length || 0;
    const totalQuantity = data.items?.reduce((sum, item) => sum + (item.quantity || 0), 0) || 0;

    const hasFailed = data.items?.some(item => item.qc_status === 'failed');
    const hasPending = data.items?.some(item => item.qc_status === 'pending');

    let alertHtml = '';
    let headerClass = 'modal-header bg-success text-white';

    if (hasFailed) {
        headerClass = 'modal-header bg-danger text-white';
        alertHtml = `<div class="alert alert-danger d-flex align-items-center mb-4"><i class="fas fa-exclamation-triangle fa-2x me-3"></i><div><strong>Có hàng không đạt chất lượng</strong><br><small>Một hoặc nhiều mã hàng đã bị QC từ chối. Hàng này chưa được nhập vào kho.</small></div></div>`;
    } else if (hasPending) {
        headerClass = 'modal-header bg-warning text-dark';
        alertHtml = `<div class="alert alert-warning d-flex align-items-center mb-4"><i class="fas fa-clock fa-2x me-3"></i><div><strong>Phiếu đang chờ xử lý QC</strong><br><small>Các mã hàng cần được QC kiểm tra trước khi được nhập vào kho.</small></div></div>`;
    } else {
        alertHtml = `<div class="alert alert-success d-flex align-items-center mb-4"><i class="fas fa-check-circle fa-2x me-3"></i><div><strong>Nhập kho thành công</strong><br><small>Tất cả các mã hàng đã được kiểm tra và nhập vào kho.</small></div></div>`;
    }

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="${headerClass}">
                    <h5 class="modal-title"><i class="fas fa-download"></i> Chi tiết phiếu nhập kho</h5>
                    <button type="button" class="btn-close ${headerClass.includes('text-white') ? 'btn-close-white' : ''}" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    ${alertHtml}
                    <div class="row mb-3 theme-aware-info-box">
                        <div class="col-12 mb-2"><span class="badge bg-success"><i class="fas fa-download"></i> Phiếu nhập kho</span></div>
                        <div class="col-md-6"><strong>Số phiếu:</strong> ${data.importNumber}</div>
                        <div class="col-md-6"><strong>Nhà cung cấp:</strong> ${data.supplier}</div>
                        <div class="col-md-6"><strong>Người tạo phiếu:</strong> ${data.performedByName}</div>
                        <div class="col-md-6"><strong>Ngày tạo:</strong> ${date}</div>
                        <div class="col-md-6"><strong>Tổng số mã hàng:</strong> ${totalItems}</div>
                        <div class="col-md-6"><strong>Tổng số lượng:</strong> ${totalQuantity}</div>
                    </div>
                    
                    <h6 class="text-muted mb-3"><i class="fas fa-list me-2"></i>Danh sách hàng hóa nhập kho</h6>
                    <div class="table-responsive">
                        <table class="table table-bordered table-compact">
                            <thead class="table-light">
                                <tr class="text-center">
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Số lượng</th>
                                    <th>Vị trí</th>
                                    <th>Trạng thái & Người QC</th>
                                    ${userRole === 'qc' ? '<th>Hành động</th>' : ''}
                                </tr>
                            </thead>
                            <tbody>
                                ${data.items?.map((item, index) => {
        // THÊM MỚI: Chuẩn bị HTML cho tên người QC
        const qcByNameHtml = item.qc_by_name ? `<small class="text-muted d-block">bởi: ${item.qc_by_name}</small>` : '';
        let locationDisplay, statusDisplay, actionButtons = '';

        switch (item.qc_status) {
            case 'passed':
                locationDisplay = `<span class="badge bg-success">${item.location}</span>`;
                // SỬA LẠI: Bọc trong div và thêm tên người QC
                statusDisplay = `<div><span class="badge bg-success"><i class="fas fa-check-circle"></i> Đạt</span>${qcByNameHtml}</div>`;
                break;
            case 'failed':
                locationDisplay = `<span class="badge bg-danger">Chưa nhập</span>`;
                // SỬA LẠI: Bọc trong div và thêm tên người QC
                statusDisplay = `<div><span class="badge bg-danger"><i class="fas fa-times-circle"></i> Không đạt</span>${qcByNameHtml}</div>`;
                if (userRole === 'qc') {
                    actionButtons = `<small class="text-muted">Đã đánh dấu</small>`;
                }
                break;
            case 'replaced':
                locationDisplay = `<span class="badge bg-secondary">Đã xử lý</span>`;
                statusDisplay = `<span class="badge bg-secondary"><i class="fas fa-sync-alt"></i> Đã giao bù</span>`;
                break;
            default: // 'pending'
                locationDisplay = `<span class="badge bg-secondary">Chờ QC</span>`;
                statusDisplay = `<span class="badge bg-warning text-dark"><i class="fas fa-clock"></i> Chờ duyệt</span>`;
                if (userRole === 'qc') {
                    actionButtons = `<button class="btn btn-sm btn-success me-1" onclick="approveQcItem('${transactionId}', ${index})"><i class="fas fa-check"></i> Đạt</button><button class="btn btn-sm btn-danger" onclick="rejectQcItem('${transactionId}', ${index})"><i class="fas fa-times"></i> Không đạt</button>`;
                }
                break;
        }

        return `<tr data-index="${index}">
                    <td class="text-center"><strong>${item.code}</strong></td>
                    <td>${item.name}</td>
                    <td class="text-center">${item.quantity}</td>
                    <td class="text-center qc-location">${locationDisplay}</td>
                    <td class="text-center qc-status">${statusDisplay}</td>
                    ${userRole === 'qc' ? `<td class="text-center qc-actions">${actionButtons}</td>` : ''}
                </tr>`;
    }).join('') || '<tr><td colspan="6" class="text-center">Không có dữ liệu</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-info" id="replacementBtn" onclick="startReplacementProcess('${transactionId}')" style="display: ${hasFailed ? 'inline-block' : 'none'}"><i class="fas fa-sync-alt"></i> NCC đã giao bù hàng</button>
                    <button type="button" class="btn btn-primary" onclick="printTransactionSlip('${transactionId}', 'import')"><i class="fas fa-print"></i> In phiếu</button>
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;
    return modal;
}


window.printTransactionSlip = async function (transactionId, type) {
    try {
        const docRef = doc(db, 'transactions', transactionId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            await generatePdfForTransaction(docSnap.data(), type);
        } else {
            showToast('Không tìm thấy dữ liệu phiếu để in.', 'danger');
        }
    } catch (error) {
        console.error('Lỗi khi chuẩn bị in phiếu:', error);
        showToast('Đã xảy ra lỗi khi chuẩn bị in.', 'danger');
    }
}

async function generatePdfForTransaction(data, type) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    try {
        const fontUrl = '/fonts/Roboto-Regular.ttf'; // Đường dẫn tới font của bạn
        const fontResponse = await fetch(fontUrl);
        if (!fontResponse.ok) throw new Error('Font not found');
        const font = await fontResponse.arrayBuffer();
        const fontBase64 = btoa(new Uint8Array(font).reduce((data, byte) => data + String.fromCharCode(byte), ''));
        doc.addFileToVFS('Roboto-Regular.ttf', fontBase64);
        doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
        doc.setFont('Roboto');
    } catch (error) {
        console.warn("Không thể tải font tùy chỉnh, PDF có thể hiển thị lỗi font. Lỗi: ", error);
        // Nếu không tải được, jsPDF sẽ dùng font mặc định
    }

    doc.setFontSize(10);
    doc.text(companyInfo.name.toUpperCase() || 'TÊN CÔNG TY', 14, 15);
    doc.setFontSize(9);
    doc.text(`Địa chỉ: ${companyInfo.address || 'ĐỊA CHỈ CÔNG TY'}`, 14, 20);

    const isImport = type === 'import';
    const title = isImport ? 'PHIẾU NHẬP KHO' : 'PHIẾU XUẤT KHO';
    const slipNumber = isImport ? data.importNumber : data.exportNumber;
    const partnerLabel = isImport ? 'Nhà cung cấp:' : 'Người nhận:';
    const partnerName = isImport ? data.supplier : data.recipient;
    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';

    // --- Header ---
    doc.setFontSize(18);
    doc.text(title, 105, 30, { align: 'center' });
    doc.setFontSize(10);
    doc.text(`Ngày: ${date}`, 105, 37, { align: 'center' });
    doc.text(`Số: ${slipNumber}`, 105, 44, { align: 'center' });

    // --- Info ---
    doc.setFontSize(12);
    doc.text(partnerLabel, 14, 55);
    doc.text(partnerName, 50, 55);
    doc.text('Người lập phiếu:', 14, 62);
    doc.text(data.performedByName, 50, 62);

    // --- Table ---
    const tableColumn = ["STT", "Mã hàng", "Tên mã hàng", "ĐVT", "Số lượng"];
    const tableRows = [];

    data.items.forEach((item, index) => {
        const itemData = [
            index + 1,
            item.code,
            item.name,
            item.unit,
            item.quantity
        ];
        tableRows.push(itemData);
    });

    doc.autoTable({
        head: [tableColumn],
        body: tableRows,
        startY: 70,
        theme: 'grid',
        headStyles: { font: 'Roboto', fontStyle: 'bold' },
        styles: { font: 'Roboto' }
    });

    // --- Footer (Chữ ký) ---
    const finalY = doc.lastAutoTable.finalY + 20;
    doc.setFontSize(11);
    doc.text('Người nhận hàng', 30, finalY, { align: 'center' });
    doc.text('Người giao hàng', 105, finalY, { align: 'center' });
    doc.text('Thủ kho', 180, finalY, { align: 'center' });

    doc.setFontSize(10);
    doc.text('(Ký, họ tên)', 30, finalY + 5, { align: 'center' });
    doc.text('(Ký, họ tên)', 105, finalY + 5, { align: 'center' });
    doc.text('(Ký, họ tên)', 180, finalY + 5, { align: 'center' });

    // --- Save the PDF ---
    const filename = `${type === 'import' ? 'PhieuNhap' : 'PhieuXuat'}_${slipNumber}.pdf`;
    doc.save(filename);
}

// Export Section Functions
export function loadExportSection() {
    initializeRealtimeHistoryTable('export');
}

function showExportModal() {
    currentExportItems = []; // Reset danh sách mỗi khi mở
    const modal = createExportModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        document.getElementById('exportNumber').focus();
    });

    modal.addEventListener('hidden.bs.modal', () => {
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
                    <h5 class="modal-title"><i class="fas fa-upload"></i> Tạo phiếu xuất kho</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="exportForm" onsubmit="return false;">
                        <!-- THÔNG TIN PHIẾU -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact" style="color: #ffc107;">
                                <i class="fas fa-file-alt"></i> Thông tin phiếu xuất
                            </div>
                            <div class="row">
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact"><i class="fas fa-hashtag text-warning"></i> Số phiếu xuất <span class="text-danger">*</span></label>
                                        <input type="text" class="form-control-compact" id="exportNumber" required>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="form-group-compact">
                                        <label class="form-label-compact"><i class="fas fa-user text-warning"></i> Người nhận <span class="text-danger">*</span></label>
                                        <input type="text" class="form-control-compact" id="recipient" required>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- THÊM mã hàng (GIAO DIỆN GIỐNG NHẬP KHO) -->
                        <div class="form-section-compact form-section-collapsible" id="addExportItemSection">
                            <div class="form-section-header-compact" style="color: #ffc107;">
                                <i class="fas fa-plus-circle"></i> Thêm mã hàng
                                <button type="button" class="collapse-toggle" onclick="toggleExportItemSection()">
                                    <i class="fas fa-chevron-up" id="exportCollapseIcon"></i> Thu gọn
                                </button>
                            </div>
                            <div class="form-section-body">
                                <div class="row quick-add-row mb-2">
                                    <div class="col-md-3">
                                        <label class="form-label-compact"><i class="fas fa-barcode text-warning"></i> Tìm mã hàng *</label>
                                        <div class="autocomplete-container-compact">
                                            <input type="text" class="form-control-compact" id="exportItemSearch" placeholder="Nhập mã hoặc tên..." autocomplete="off">
                                            <div class="suggestion-dropdown-compact" id="exportItemSuggestions" style="display: none;"></div>
                                        </div>
                                    </div>
                                    <div class="col-md-3">
                                        <label class="form-label-compact"><i class="fas fa-tag text-warning"></i> Tên mô tả</label>
                                        <input type="text" class="form-control-compact" id="exportItemName" readonly>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact"><i class="fas fa-map-marker-alt text-warning"></i> Vị trí</label>
                                        <input type="text" class="form-control-compact" id="exportItemLocation" readonly>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact"><i class="fas fa-warehouse text-warning"></i> Tồn kho</label>
                                        <input type="text" class="form-control-compact" id="exportAvailableStock" readonly>
                                    </div>
                                    <div class="col-md-2">
                                        <label class="form-label-compact"><i class="fas fa-sort-numeric-up text-warning"></i> SL Xuất *</label>
                                        <input type="number" class="form-control-compact" id="exportQuantity" placeholder="0" required min="1">
                                    </div>
                                    <!-- Hidden fields để lưu trữ dữ liệu cần thiết -->
                                    <input type="hidden" id="exportInventoryId">
                                    <input type="hidden" id="exportItemCode">
                                    <input type="hidden" id="exportItemUnit">
                                </div>
                                <div class="row align-items-end">
                                    <div class="col-md-9"><small class="text-muted"><i class="fas fa-lightbulb"></i> Tìm mã hàng, chọn vị trí (nếu cần), sau đó nhập số lượng.</small></div>
                                    <div class="col-md-3 text-end">
                                        <button type="button" class="btn btn-warning btn-sm text-dark" onclick="addExportItem()">
                                            <i class="fas fa-plus"></i> Thêm vào danh sách
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- DANH SÁCH HÀNG HÓA XUẤT KHO -->
                        <div class="form-section-compact">
                            <div class="form-section-header-compact" style="color: #ffc107;">
                                <i class="fas fa-list-check"></i> Danh sách hàng hóa xuất kho
                                <span class="badge bg-warning text-dark ms-auto" id="exportItemCountBadge">0 mã hàng</span>
                            </div>
                            <div class="table-responsive">
                                <table class="table table-bordered table-compact">
                                    <thead class="table-warning">
                                        <tr class="text-center">
                                            <th>Mã hàng</th>
                                            <th>Tên mô tả</th>
                                            <th>Vị trí</th>
                                            <th>SL xuất</th>
                                            <th>Đơn vị</th>
                                            <th>Thao tác</th>
                                        </tr>
                                    </thead>
                                    <tbody id="exportItemsTable">
                                        <tr id="emptyExportTableRow"><td colspan="6" class="text-center text-muted py-3">Chưa có hàng hóa nào để xuất</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal"><i class="fas fa-times"></i> Hủy</button>
                    <button type="button" class="btn btn-warning text-dark" onclick="saveExport()" id="saveExportBtn" disabled><i class="fas fa-save"></i> Lưu phiếu xuất</button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        setupExportModalEventListeners();
    }, 0);

    return modal;
}

function suggestExportNumber() {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = today.toTimeString().slice(0, 5).replace(':', '');
    const suggested = `XK${dateStr}${timeStr}`;
    document.getElementById('exportNumber').placeholder = `Gợi ý: ${suggested}`;
}

function createLocationCard(docId, data, targetPrefix) {
    const card = document.createElement('div');
    card.className = 'col-md-6 mb-3';

    // Xác định hàm sẽ được gọi khi click
    let clickHandler = '';
    if (targetPrefix === 'transfer') {
        clickHandler = `selectLocationForTransfer('${docId}', JSON.parse('${JSON.stringify(data).replace(/'/g, "\\'")}'))`;
    } else { // Mặc định là cho 'adjust'
        clickHandler = `selectLocationForAdjust('${docId}', '${targetPrefix}', JSON.parse('${JSON.stringify(data).replace(/'/g, "\\'")}'))`;
    }

    card.innerHTML = `
        <div class="card h-100 location-card" data-doc-id="${docId}" data-target="${targetPrefix}" onclick="${clickHandler}">
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

// HÀM MỚI ĐÃ SỬA LỖI
window.saveDirectAdjust = async function () {
    if (userRole !== 'super_admin') {
        showToast('Chỉ Super Admin mới có quyền chỉnh số trực tiếp', 'danger');
        return;
    }

    try {
        const inventoryId = document.getElementById('directAdjustInventoryId').value;
        const currentStockInput = document.getElementById('directAdjustCurrentStock').value;
        const currentQuantity = parseInt(currentStockInput) || 0;
        const newQuantityStr = document.getElementById('directAdjustNewQuantity').value;
        const reason = document.getElementById('directAdjustReason').value.trim();

        if (!inventoryId) {
            showToast('Vui lòng chọn một mã hàng hợp lệ từ danh sách gợi ý.', 'warning');
            return;
        }
        if (newQuantityStr === '' || isNaN(parseInt(newQuantityStr))) {
            showToast('Vui lòng nhập số lượng mới hợp lệ.', 'warning');
            return;
        }
        const newQuantity = parseInt(newQuantityStr);
        if (newQuantity < 0) {
            showToast('Số lượng mới không được âm.', 'warning');
            return;
        }
        if (!reason) {
            showToast('Vui lòng nhập lý do điều chỉnh.', 'warning');
            return;
        }
        if (newQuantity === currentQuantity) {
            showToast('Số lượng mới giống số lượng hiện tại, không có gì để điều chỉnh.', 'info');
            return;
        }

        const confirmed = await showConfirmation(
            'Xác nhận chỉnh số trực tiếp',
            `Bạn có chắc muốn điều chỉnh tồn kho từ ${currentQuantity} thành ${newQuantity}?`,
            'Thực hiện chỉnh số', 'Hủy', 'danger'
        );
        if (!confirmed) return;

        const inventoryRef = doc(db, 'inventory', inventoryId);
        const inventorySnap = await getDoc(inventoryRef);
        if (!inventorySnap.exists()) {
            showToast('Không tìm thấy thông tin tồn kho.', 'danger');
            return;
        }
        const inventoryData = inventorySnap.data();
        const batch = writeBatch(db);

        batch.update(inventoryRef, { quantity: newQuantity });

        // --- SỬA LỖI Ở ĐÂY ---
        // Gói toàn bộ thông tin chi tiết của mã hàng vào một mảng tên là "items",
        // để có cùng cấu trúc với các yêu cầu chỉnh số được duyệt.
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'adjust',
            subtype: 'direct', 
            reason: reason,
            items: [ // Bọc thông tin chi tiết vào một mảng
                {
                    inventoryId: inventoryId, // Lưu lại ID để dễ truy vết
                    itemCode: inventoryData.code,
                    itemName: inventoryData.name,
                    location: inventoryData.location,
                    previousQuantity: currentQuantity,
                    newQuantity: newQuantity,
                    adjustment: newQuantity - currentQuantity,
                }
            ],
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });
        // --- KẾT THÚC SỬA LỖI ---

        await batch.commit();

        showToast('Chỉnh số trực tiếp thành công!', 'success');
        const modal = document.getElementById('directAdjustModal');
        if (modal) {
            bootstrap.Modal.getInstance(modal).hide();
        }

        // Tải lại dữ liệu của tab chỉnh số
        loadAdjustData();

    } catch (error) {
        console.error('Lỗi khi chỉnh số trực tiếp:', error);
        showToast('Lỗi nghiêm trọng khi chỉnh số trực tiếp.', 'danger');
    }
};

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
        <div class="modal-dialog modal-xl">
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
                        <!-- THÔNG TIN mã hàng -->
                        <div class="row mb-3 p-3 theme-aware-inset-box rounded">
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
    document.getElementById('exportItemSearch')?.addEventListener('input', debounce(handleExportItemSearch, 300));
    document.getElementById('exportItemSearch')?.addEventListener('blur', () => setTimeout(() => hideSuggestions('exportItemSuggestions'), 200));
    document.getElementById('exportNumber')?.addEventListener('input', updateExportSaveButtonState);
    document.getElementById('recipient')?.addEventListener('input', updateExportSaveButtonState);
    suggestExportNumber();
}

// warehouse.js

async function handleExportItemSearch(event) {
    const searchTerm = event.target.value.trim();
    const suggestionsContainer = document.getElementById('exportItemSuggestions');
    suggestionsContainer.innerHTML = '';

    if (searchTerm.length < 2) return;

    try {
        // BỎ ĐIỀU KIỆN LỌC 'status' KHỎI CÂU TRUY VẤN
        const codeQuery = query(collection(db, 'inventory'), where('quantity', '>', 0), where('code', '>=', searchTerm.toUpperCase()), where('code', '<=', searchTerm.toUpperCase() + '\uf8ff'), limit(10));
        const nameQuery = query(collection(db, 'inventory'), where('quantity', '>', 0), where('name', '>=', searchTerm), where('name', '<=', searchTerm + '\uf8ff'), limit(10));

        const [codeSnapshot, nameSnapshot] = await Promise.all([getDocs(codeQuery), getDocs(nameQuery)]);
        const resultsMap = new Map();

        codeSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));
        nameSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));

        // THÊM: Lọc kết quả trên client
        const activeResults = Array.from(resultsMap.values())
            .filter(item => item.status !== 'archived');

        if (activeResults.length === 0) {
            suggestionsContainer.style.display = 'none';
            return;
        }

        suggestionsContainer.innerHTML = activeResults.map(item => {
            const itemJsonString = JSON.stringify(item).replace(/'/g, "\\'");
            return `<div class="suggestion-item-compact" onclick='selectItemForExport(${itemJsonString})'>
                        <strong>${item.code}</strong> - ${item.name} (Vị trí: ${item.location} | Tồn: ${item.quantity})
                    </div>`;
        }).join('');
        suggestionsContainer.style.display = 'block';
    } catch (error) {
        console.error("Lỗi tìm kiếm hàng xuất kho:", error);
    }
}

window.selectItemForExport = function (item) {
    // Điền thông tin vào các trường của form
    document.getElementById('exportInventoryId').value = item.id;
    document.getElementById('exportItemSearch').value = `${item.code} - ${item.name}`;
    document.getElementById('exportItemCode').value = item.code;
    document.getElementById('exportItemName').value = item.name;
    document.getElementById('exportItemUnit').value = item.unit;
    document.getElementById('exportItemLocation').value = item.location;
    document.getElementById('exportAvailableStock').value = item.quantity;
    document.getElementById('exportQuantity').max = item.quantity;

    hideSuggestions('exportItemSuggestions');
    document.getElementById('exportQuantity').focus();
};

function updateExportSaveButtonState() {
    const saveBtn = document.getElementById('saveExportBtn');
    if (!saveBtn) return;
    const hasBasicInfo = document.getElementById('exportNumber').value.trim() && document.getElementById('recipient').value.trim();
    saveBtn.disabled = !hasBasicInfo;
}

function updateTransferSaveButtonState() {
    const saveBtn = document.getElementById('saveTransferBtn');
    if (!saveBtn) return; // Thêm dòng này để phòng trường hợp nút không tồn tại

    // SỬA LẠI: Kiểm tra các ô nhập liệu mới
    const hasSourceInfo = document.getElementById('sourceInventoryId').value &&
        document.getElementById('transferQuantity').value;

    const hasDestinationInfo = document.getElementById('transferNewAisle').value &&
        document.getElementById('transferNewBay').value &&
        document.getElementById('transferNewLevel').value;

    // Chỉ bật nút khi tất cả thông tin cần thiết đã được điền
    saveBtn.disabled = !(hasSourceInfo && hasDestinationInfo);
}

async function handleExportItemCodeInput(event) {
    const code = event.target.value.trim().toUpperCase();
    const locationSelectionDiv = document.getElementById('exportLocationSelection');
    const locationListDiv = document.getElementById('exportLocationList');
    const itemDetailsDiv = document.getElementById('exportItemDetails');

    // Reset giao diện
    locationSelectionDiv.style.display = 'none';
    locationListDiv.innerHTML = '';
    itemDetailsDiv.style.display = 'none';

    if (code.length < 2) return;

    try {
        const inventoryQuery = query(collection(db, 'inventory'), where('code', '==', code), where('quantity', '>', 0));
        const snapshot = await getDocs(inventoryQuery);
        if (snapshot.empty) return;

        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (results.length === 1) {
            selectLocationForExport(results[0].id, results[0]);
        } else {
            locationListDiv.innerHTML = results.map(item => `
                <div class="col-md-4 mb-2">
                    <div class="card location-card h-100" onclick="selectLocationForExport('${item.id}', JSON.parse('${JSON.stringify(item).replace(/'/g, "\\'")}'))">
                        <div class="card-body text-center p-2">
                            <h6 class="card-title text-primary mb-1"><i class="fas fa-map-marker-alt"></i> ${item.location}</h6>
                            <p class="card-text mb-0"><span class="badge bg-success">Tồn: ${item.quantity}</span></p>
                        </div>
                    </div>
                </div>
            `).join('');
            locationSelectionDiv.style.display = 'block';
        }
    } catch (error) {
        console.error("Lỗi tìm mã hàng xuất kho:", error);
        showToast('Lỗi khi tìm mã hàng', 'danger');
    }
}

window.selectLocationForExport = function (docId, data) {
    document.getElementById('exportLocationSelection').style.display = 'none';
    const itemDetailsDiv = document.getElementById('exportItemDetails');
    document.getElementById('selectedExportInventoryId').value = docId;
    document.getElementById('exportItemName').value = data.name;
    document.getElementById('exportItemName').dataset.unit = data.unit || '';
    document.getElementById('exportItemLocation').value = data.location;
    document.getElementById('exportCurrentStock').value = data.quantity;
    document.getElementById('exportQuantity').max = data.quantity;
    itemDetailsDiv.style.display = 'block';
    document.getElementById('exportQuantity').focus();
}

window.editExportItem = function (index) {
    const itemToEdit = currentExportItems[index];
    if (!itemToEdit) return; // Kiểm tra an toàn

    // Điền lại thông tin của mã hàng vào form để người dùng sửa
    document.getElementById('exportItemSearch').value = `${itemToEdit.code} - ${itemToEdit.name}`;
    document.getElementById('exportInventoryId').value = itemToEdit.inventoryId;
    document.getElementById('exportItemCode').value = itemToEdit.code;
    document.getElementById('exportItemName').value = itemToEdit.name;
    document.getElementById('exportItemUnit').value = itemToEdit.unit;
    document.getElementById('exportItemLocation').value = itemToEdit.location;
    document.getElementById('exportAvailableStock').value = itemToEdit.availableQuantity;
    document.getElementById('exportQuantity').value = itemToEdit.quantity; // Đặt lại số lượng cần sửa
    document.getElementById('exportQuantity').max = itemToEdit.availableQuantity;

    // Tạm thời xóa mã hàng khỏi danh sách.
    // Người dùng sẽ thêm lại nó với thông tin mới bằng cách nhấn nút "Thêm vào danh sách".
    currentExportItems.splice(index, 1);

    // Cập nhật lại bảng để phản ánh việc mã hàng đã được đưa lên form sửa
    updateExportItemsTable();

    // Đảm bảo khu vực "Thêm mã hàng" đang mở để người dùng có thể thấy thông tin
    const section = document.getElementById('addExportItemSection');
    if (section.classList.contains('collapsed')) {
        toggleExportItemSection();
    }

    // Tập trung vào ô số lượng để tiện cho việc sửa đổi
    document.getElementById('exportQuantity').focus();
    document.getElementById('exportQuantity').select();
};


window.addExportItem = function () {
    const item = {
        inventoryId: document.getElementById('exportInventoryId').value,
        code: document.getElementById('exportItemCode').value,
        name: document.getElementById('exportItemName').value,
        unit: document.getElementById('exportItemUnit').value,
        location: document.getElementById('exportItemLocation').value,
        quantity: parseInt(document.getElementById('exportQuantity').value),
        availableQuantity: parseInt(document.getElementById('exportAvailableStock').value)
    };

    if (!item.inventoryId || !item.code || isNaN(item.quantity) || item.quantity <= 0) {
        return showToast('Vui lòng chọn mã hàng và nhập số lượng hợp lệ.', 'warning');
    }
    if (item.quantity > item.availableQuantity) {
        return showToast('Số lượng xuất vượt quá tồn kho tại vị trí này.', 'warning');
    }

    const existingIndex = currentExportItems.findIndex(i => i.inventoryId === item.inventoryId);
    if (existingIndex >= 0) {
        const newTotal = currentExportItems[existingIndex].quantity + item.quantity;
        if (newTotal > item.availableQuantity) {
            return showToast('Tổng số lượng xuất đã vượt quá tồn kho.', 'warning');
        }
        currentExportItems[existingIndex].quantity = newTotal;
    } else {
        currentExportItems.push(item);
    }
    updateExportItemsTable();
    resetExportItemForm();
};

function resetExportItemForm() {
    const ids = ['exportItemSearch', 'exportInventoryId', 'exportItemCode', 'exportItemName', 'exportItemUnit', 'exportItemLocation', 'exportAvailableStock', 'exportQuantity'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('exportItemSearch').focus();
}

function updateExportItemsTable() {
    const tbody = document.getElementById('exportItemsTable');

    // Thêm một bước kiểm tra an toàn: nếu không tìm thấy tbody thì không làm gì cả.
    if (!tbody) {
        return;
    }

    if (currentExportItems.length === 0) {
        // Nếu không có mã hàng nào, hãy tạo lại hàng placeholder.
        tbody.innerHTML = `<tr id="emptyExportTableRow"><td colspan="6" class="text-center text-muted py-3">Chưa có hàng hóa nào để xuất</td></tr>`;
    } else {
        // Nếu có mã hàng, hãy tạo danh sách các hàng đó.
        tbody.innerHTML = currentExportItems.map((item, index) => `
            <tr>
                <td class="text-center"><strong>${item.code}</strong></td>
                <td>${item.name}</td>
                <td class="text-center"><span class="badge bg-secondary">${item.location}</span></td>
                <td class="text-center"><span class="badge bg-warning text-dark">${item.quantity}</span></td>
                <td class="text-center">${item.unit}</td>
                <td class="text-center">
                    <button class="btn btn-warning btn-sm me-1" onclick="editExportItem(${index})"><i class="fas fa-edit"></i> Sửa</button>
                    <button class="btn btn-danger btn-sm" onclick="removeExportItem(${index})"><i class="fas fa-trash"></i> Xóa</button>
                </td>
            </tr>
        `).join('');
    }

    // Cập nhật số lượng mã hàng (phần này vẫn đúng)
    document.getElementById('exportItemCountBadge').textContent = `${currentExportItems.length} mã hàng`;
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
                    <h5 class="modal-title"><i class="fas fa-paper-plane"></i> Tạo Yêu cầu Chỉnh số</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="adjustRequestForm" onsubmit="return false;">
                        <div class="form-section-compact">
                            <div class="form-section-header-compact"><i class="fas fa-file-alt"></i> Thông tin chung</div>
                            <div class="form-group-compact">
                                <label class="form-label-compact"><i class="fas fa-comment text-primary"></i> Lý do chung cho yêu cầu <span class="text-danger">*</span></label>
                                <input type="text" class="form-control-compact" id="requestGeneralReason" placeholder="VD: Kiểm kê kho định kỳ tháng 12..." required>
                            </div>
                        </div>

                        <div class="form-section-compact">
                            <div class="form-section-header-compact"><i class="fas fa-plus-circle"></i> Thêm mã hàng cần chỉnh số</div>
                             <div class="row quick-add-row mb-2">
                                <div class="col-md-4">
                                    <label class="form-label-compact"><i class="fas fa-barcode text-primary"></i> Tìm mã hàng *</label>
                                    <div class="autocomplete-container-compact">
                                        <input type="text" class="form-control-compact" id="requestItemSearch" placeholder="Nhập mã hoặc tên..." autocomplete="off">
                                        <div class="suggestion-dropdown-compact" id="requestItemSuggestions" style="display: none;"></div>
                                    </div>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label-compact"><i class="fas fa-warehouse text-primary"></i> Tồn kho</label>
                                    <input type="text" class="form-control-compact" id="requestAvailableStock" readonly>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label-compact"><i class="fas fa-sort-numeric-up text-primary"></i> SL thực tế *</label>
                                    <input type="number" class="form-control-compact" id="requestNewQuantity" placeholder="0" required min="0">
                                </div>
                                <div class="col-md-4 text-end align-self-end">
                                    <button type="button" class="btn btn-primary btn-sm" onclick="addRequestItemToList()"><i class="fas fa-plus"></i> Thêm vào danh sách</button>
                                </div>
                                <input type="hidden" id="requestInventoryId"><input type="hidden" id="requestItemCode">
                                <input type="hidden" id="requestItemName"><input type="hidden" id="requestItemLocation">
                            </div>
                        </div>

                        <div class="form-section-compact">
                            <div class="form-section-header-compact"><i class="fas fa-list-check"></i> Danh sách yêu cầu</div>
                            <div class="table-responsive">
                                <table class="table table-bordered table-compact">
                                    <thead class="table-primary">
                                        <tr>
                                            <th>Mã hàng</th><th>Tên & Vị trí</th><th>SL Cũ</th><th>SL Mới</th><th>Chênh lệch</th><th>Thao tác</th>
                                        </tr>
                                    </thead>
                                    <tbody id="requestItemsTable">
                                        <tr><td colspan="6" class="text-center text-muted py-3">Chưa có yêu cầu nào.</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-primary" onclick="saveAdjustRequest()"><i class="fas fa-paper-plane"></i> Gửi yêu cầu</button>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => {
        document.getElementById('requestItemSearch')?.addEventListener('input', debounce(handleRequestItemSearch, 300));
        document.getElementById('requestItemSearch')?.addEventListener('blur', () => setTimeout(() => hideSuggestions('requestItemSuggestions'), 200));
    }, 0);
    return modal;
}

window.addRequestItemToList = function () {
    const newQuantity = parseInt(document.getElementById('requestNewQuantity').value);
    const item = {
        inventoryId: document.getElementById('requestInventoryId').value,
        code: document.getElementById('requestItemCode').value,
        name: document.getElementById('requestItemName').value,
        location: document.getElementById('requestItemLocation').value,
        currentQuantity: parseInt(document.getElementById('requestAvailableStock').value),
        requestedQuantity: isNaN(newQuantity) ? 0 : newQuantity,
    };
    if (!item.inventoryId || !item.code || isNaN(newQuantity)) {
        return showToast('Vui lòng chọn mã hàng và nhập số lượng hợp lệ.', 'warning');
    }
    const existingIndex = currentRequestItems.findIndex(i => i.inventoryId === item.inventoryId);
    if (existingIndex !== -1) {
        currentRequestItems[existingIndex] = item;
    } else {
        currentRequestItems.push(item);
    }
    updateRequestItemsTable();
    resetRequestItemForm();
}

function updateRequestItemsTable() {
    const tbody = document.getElementById('requestItemsTable');
    if (currentRequestItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">Chưa có yêu cầu nào.</td></tr>`;
    } else {
        tbody.innerHTML = currentRequestItems.map((item, index) => {
            const diff = item.requestedQuantity - item.currentQuantity;
            const diffClass = diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : 'text-muted';
            const diffSymbol = diff > 0 ? '+' : '';
            return `<tr>
                        <td><strong>${item.code}</strong></td>
                        <td>${item.name}<br><small class="text-muted">Vị trí: ${item.location}</small></td>
                        <td>${item.currentQuantity}</td>
                        <td>${item.requestedQuantity}</td>
                        <td class="${diffClass}">${diffSymbol}${diff}</td>
                        <td><button class="btn btn-danger btn-sm" onclick="removeRequestItem(${index})"><i class="fas fa-trash"></i></button></td>
                    </tr>`;
        }).join('');
    }
}

window.removeRequestItem = function (index) {
    currentRequestItems.splice(index, 1);
    updateRequestItemsTable();
}

function resetRequestItemForm() {
    ['requestItemSearch', 'requestInventoryId', 'requestItemCode', 'requestItemName', 'requestItemLocation', 'requestAvailableStock', 'requestNewQuantity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('requestItemSearch').focus();
}

async function handleRequestItemSearch(event) {
    const searchTerm = event.target.value.trim();
    const suggestionsContainer = document.getElementById('requestItemSuggestions');
    suggestionsContainer.innerHTML = '';
    if (searchTerm.length < 2) return;
    try {
        // BỎ ĐIỀU KIỆN LỌC 'status' KHỎI CÂU TRUY VẤN
        const codeQuery = query(collection(db, 'inventory'), where('code', '>=', searchTerm.toUpperCase()), where('code', '<=', searchTerm.toUpperCase() + '\uf8ff'), limit(10));
        const nameQuery = query(collection(db, 'inventory'), where('name', '>=', searchTerm), where('name', '<=', searchTerm + '\uf8ff'), limit(10));

        const [codeSnapshot, nameSnapshot] = await Promise.all([getDocs(codeQuery), getDocs(nameQuery)]);
        const resultsMap = new Map();

        codeSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));
        nameSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));

        // THÊM: Lọc kết quả trên client để loại bỏ mã hàng đã xóa
        const activeResults = Array.from(resultsMap.values())
            .filter(item => item.status !== 'archived');

        if (activeResults.length === 0) {
            suggestionsContainer.style.display = 'none';
            return;
        }
        suggestionsContainer.innerHTML = activeResults.map(item => {
            const itemJsonString = JSON.stringify(item).replace(/'/g, "\\'");
            return `<div class="suggestion-item-compact" onclick='selectItemForRequest(${itemJsonString})'>
                        <strong>${item.code}</strong> - ${item.name} (Vị trí: ${item.location} | Tồn: ${item.quantity})
                    </div>`;
        }).join('');
        suggestionsContainer.style.display = 'block';
    } catch (error) {
        console.error("Lỗi tìm kiếm hàng để yêu cầu:", error);
    }
}

window.selectItemForRequest = function (item) {
    document.getElementById('requestInventoryId').value = item.id;
    document.getElementById('requestItemSearch').value = `${item.code} - ${item.name}`;
    document.getElementById('requestItemCode').value = item.code;
    document.getElementById('requestItemName').value = item.name;
    document.getElementById('requestItemLocation').value = item.location;
    document.getElementById('requestAvailableStock').value = item.quantity;
    document.getElementById('requestNewQuantity').value = item.quantity;
    hideSuggestions('requestItemSuggestions');
    document.getElementById('requestNewQuantity').focus();
    document.getElementById('requestNewQuantity').select();
};

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
            locationList.innerHTML = '<div class="col-12"><p class="text-danger p-2">Không tìm thấy mã hàng với mã này.</p></div>';
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
    const generalReason = document.getElementById('requestGeneralReason').value.trim();
    if (!generalReason) return showToast('Vui lòng nhập lý do chung cho yêu cầu.', 'warning');
    if (currentRequestItems.length === 0) return showToast('Vui lòng thêm ít nhất một mã hàng vào yêu cầu.', 'warning');

    try {
        const itemsToSave = currentRequestItems.map(item => ({
            inventoryId: item.inventoryId,
            itemCode: item.code,
            itemName: item.name,
            location: item.location,
            currentQuantity: item.currentQuantity,
            requestedQuantity: item.requestedQuantity,
            adjustment: item.requestedQuantity - item.currentQuantity,
        }));

        await addDoc(collection(db, 'adjustment_requests'), {
            reason: generalReason,
            items: itemsToSave,
            status: 'pending',
            requestedBy: currentUser.uid,
            requestedByName: currentUser.name,
            requestDate: serverTimestamp(),
            timestamp: serverTimestamp()
        });
        showToast('Yêu cầu chỉnh số đã được gửi thành công!', 'success');
        const modal = document.getElementById('adjustRequestModal');
        if (modal) bootstrap.Modal.getInstance(modal).hide();
    } catch (error) {
        console.error('Lỗi khi gửi yêu cầu chỉnh số:', error);
        showToast('Đã xảy ra lỗi khi gửi yêu cầu.', 'danger');
    }
}

window.removeExportItem = async function (index) {
    const item = currentExportItems[index];
    const confirmed = await showConfirmation('Xóa mã hàng', `Bạn có chắc muốn xóa "${item.name}" khỏi phiếu xuất?`, 'Xóa', 'Hủy', 'danger');
    if (confirmed) {
        currentExportItems.splice(index, 1);
        updateExportItemsTable();
        showToast(`Đã xóa "${item.name}"`, 'success');
    }
};

window.saveExport = async function () {
    if (currentExportItems.length === 0) {
        return showToast('Vui lòng thêm ít nhất một mã hàng vào phiếu xuất', 'warning');
    }
    const exportNumber = document.getElementById('exportNumber').value.trim();
    const recipient = document.getElementById('recipient').value.trim();
    if (!exportNumber || !recipient) {
        return showToast('Vui lòng điền đầy đủ thông tin phiếu xuất', 'warning');
    }

    try {
        const batch = writeBatch(db);
        const exportDoc = doc(collection(db, 'transactions'));
        const itemsForSave = currentExportItems.map(item => ({
            inventoryId: item.inventoryId,
            code: item.code, name: item.name, quantity: item.quantity,
            unit: item.unit, availableQuantityBefore: item.availableQuantity,
            location: item.location
        }));

        batch.set(exportDoc, {
            type: 'export', exportNumber, recipient, items: itemsForSave,
            performedBy: currentUser.uid, performedByName: currentUser.name,
            date: serverTimestamp(), timestamp: serverTimestamp()
        });

        for (const item of currentExportItems) {
            batch.update(doc(db, 'inventory', item.inventoryId), { quantity: increment(-item.quantity) });
        }

        await batch.commit();
        showToast('Xuất kho thành công!', 'success');
        const exportModal = document.getElementById('exportModal');
        if (exportModal) bootstrap.Modal.getInstance(exportModal).hide();
    } catch (error) {
        console.error('Lỗi khi lưu phiếu xuất:', error);
        showToast('Lỗi lưu phiếu xuất', 'danger');
    }
};

window.viewExportDetails = async function (transactionId) {
    try {
        const docSnap = await getDoc(doc(db, 'transactions', transactionId));
        if (!docSnap.exists()) {
            showToast('Không tìm thấy phiếu xuất', 'danger');
            return;
        }

        const data = docSnap.data();
        const modal = createExportDetailsModal(transactionId, data);
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

function createExportDetailsModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    const date = data.timestamp ? data.timestamp.toDate().toLocaleString('vi-VN') : 'N/A';
    const totalItems = data.items?.length || 0;
    const totalQuantity = data.items?.reduce((sum, item) => sum + (item.quantity || 0), 0) || 0;

    let performerInfoHtml = '';
    if (data.requestInfo) {
        performerInfoHtml = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestInfo.requestedByName || 'N/A'}</div>
            <div class="col-md-6"><strong>Người duyệt & xuất:</strong> ${data.performedByName}</div>
        `;
    } else {
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
                     <!-- ... (modal body content remains the same) ... -->
                     <div class="alert alert-warning d-flex align-items-center mb-4">
                        <i class="fas fa-check-circle fa-2x me-3"></i>
                        <div>
                            <strong>Xuất kho thành công</strong><br>
                            <small>Đã xuất ${totalItems} mã hàng với tổng số lượng ${totalQuantity} khỏi kho</small>
                        </div>
                    </div>
                    <div class="row mb-3 theme-aware-info-box">
                        <div class="col-12 mb-2">
                            <span class="badge bg-warning text-dark">
                                <i class="fas fa-upload"></i> Phiếu xuất kho
                            </span>
                        </div>
                        <div class="col-md-6"><strong>Số phiếu:</strong> ${data.exportNumber}</div>
                        <div class="col-md-6"><strong>Người nhận:</strong> ${data.recipient}</div>
                        ${performerInfoHtml}
                        <div class="col-md-6"><strong>Ngày xuất:</strong> ${date}</div>
                        <div class="col-md-6"><strong>Tổng số mã hàng:</strong> ${totalItems}</div>
                        <div class="col-md-6"><strong>Tổng số lượng:</strong> ${totalQuantity}</div>
                    </div>                    
                    <h6 class="text-muted mb-3">
                        <i class="fas fa-list me-2"></i>Danh sách hàng hóa đã xuất
                    </h6>
                    <div class="table-responsive">
                        <table class="table table-bordered table-compact" >
                            <thead>
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
                     <button type="button" class="btn btn-primary" onclick="printTransactionSlip('${transactionId}', 'export')">
                        <i class="fas fa-print"></i> In phiếu
                    </button>
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                </div>
            </div>
        </div>
    `;

    return modal;
}

// File: js/warehouse.js

window.approveAdjustRequest = async function (requestId) {
    if (userRole !== 'super_admin') return showToast('Chỉ Super Admin mới có quyền thực hiện.', 'danger');

    const confirmed = await showConfirmation(
        'Duyệt yêu cầu chỉnh số',
        'Bạn có chắc muốn duyệt yêu cầu này? Tồn kho sẽ được cập nhật theo các thay đổi.',
        'Duyệt yêu cầu', 'Hủy', 'success'
    );
    if (!confirmed) return;

    try {
        const requestRef = doc(db, 'adjustment_requests', requestId);
        const requestSnap = await getDoc(requestRef);
        if (!requestSnap.exists()) throw new Error("Yêu cầu không tồn tại.");

        const requestData = requestSnap.data();
        if (requestData.status !== 'pending') return showToast('Yêu cầu này đã được xử lý.', 'info');

        const batch = writeBatch(db);

        // Cập nhật tồn kho cho tất cả items trong yêu cầu
        for (const item of requestData.items) {
            const inventoryRef = doc(db, 'inventory', item.inventoryId);
            batch.update(inventoryRef, { quantity: item.requestedQuantity });
        }

        // Cập nhật trạng thái của yêu cầu gốc
        batch.update(requestRef, {
            status: 'approved',
            approvedBy: currentUser.uid,
            approvedByName: currentUser.name,
            approvedDate: serverTimestamp()
        });

        // === BẮT ĐẦU SỬA LỖI QUAN TRỌNG ===
        // Khi ghi log giao dịch, sao chép đầy đủ thông tin từ yêu cầu gốc
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'adjust',
            reason: requestData.reason,
            items: requestData.items,
            requestId: requestId, // Liên kết lại với yêu cầu gốc
            
            // Thông tin người duyệt (người thực hiện giao dịch)
            performedBy: currentUser.uid,
            performedByName: currentUser.name,

            // Sao chép thông tin người yêu cầu
            requestedBy: requestData.requestedBy,
            requestedByName: requestData.requestedByName,
            requestDate: requestData.requestDate,
            
            // Dấu thời gian của giao dịch
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });
        // === KẾT THÚC SỬA LỖI QUAN TRỌNG ===

        await batch.commit();
        showToast('Đã duyệt yêu cầu chỉnh số thành công.', 'success');
        // Bảng sẽ tự cập nhật nhờ onSnapshot

    } catch (error) {
        console.error('Lỗi duyệt yêu cầu chỉnh số:', error);
        showToast('Lỗi duyệt yêu cầu chỉnh số', 'danger');
    }
};


window.rejectAdjustRequest = async function (requestId) {
    if (userRole !== 'super_admin') return showToast('Chỉ Super Admin mới có quyền thực hiện.', 'danger');

    const reason = await showInputModal('Từ chối yêu cầu', 'Vui lòng nhập lý do từ chối:', 'Lý do...');
    if (!reason) return;

    try {
        const requestRef = doc(db, 'adjustment_requests', requestId);
        // Cập nhật trạng thái yêu cầu
        await updateDoc(requestRef, {
            status: 'rejected',
            rejectedBy: currentUser.uid,
            rejectedByName: currentUser.name,
            rejectedDate: serverTimestamp(),
            rejectionReason: reason
        });
        showToast('Đã từ chối yêu cầu chỉnh số.', 'success');
        updatePendingAdjustmentsBadge();
    } catch (error) {
        console.error('Lỗi từ chối yêu cầu chỉnh số:', error);
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

window.viewAdjustRequestDetails = async function (docId) {
    try {
        // Thử tìm trong collection 'adjustment_requests' trước (cho các phiếu đang chờ/bị từ chối)
        let docRef = doc(db, 'adjustment_requests', docId);
        let docSnap = await getDoc(docRef);
        let data, isRequest;

        if (docSnap.exists()) {
            data = { id: docSnap.id, ...docSnap.data(), dataType: 'request' };
        } else {
            // Nếu không tìm thấy, thử tìm trong 'transactions' (cho các phiếu đã duyệt)
            docRef = doc(db, 'transactions', docId);
            docSnap = await getDoc(docRef);
            if (!docSnap.exists()) {
                showToast('Không tìm thấy phiếu chỉnh số hoặc yêu cầu.', 'danger');
                return;
            }
            data = { id: docSnap.id, ...docSnap.data(), dataType: 'transaction' };
        }

        const modal = createAdjustRequestDetailsModal(data);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();

        modal.addEventListener('hidden.bs.modal', () => {
            modal.remove();
        });

    } catch (error) {
        console.error('Lỗi tải chi tiết chỉnh số:', error);
        showToast('Lỗi tải chi tiết chỉnh số', 'danger');
    }
};

function createAdjustRequestDetailsModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';

    // Xác định trạng thái thực tế để hiển thị
    const displayStatus = data.dataType === 'transaction' ? 'approved' : data.status;

    // --- Chuẩn bị dữ liệu ---
    const requestDate = data.requestDate?.toDate().toLocaleString('vi-VN') || 'N/A';
    const approvedDate = data.approvedDate?.toDate().toLocaleString('vi-VN') || data.timestamp?.toDate().toLocaleString('vi-VN') || 'N/A';
    const rejectedDate = data.rejectedDate?.toDate().toLocaleString('vi-VN') || 'N/A';

    const statusConfig = {
        'pending': { class: 'bg-warning text-dark', text: 'Chờ duyệt', icon: 'fas fa-clock' },
        'approved': { class: 'bg-success', text: 'Đã duyệt', icon: 'fas fa-check-circle' },
        'rejected': { class: 'bg-danger', text: 'Từ chối', icon: 'fas fa-times-circle' }
    };
    const status = statusConfig[displayStatus] || { class: 'bg-secondary', text: displayStatus, icon: 'fas fa-question-circle' };

    // --- Logic hiển thị động ---
    let infoHtml = '';
    let headerClass = 'modal-header';
    let headerTitle = 'Chi tiết Yêu cầu Chỉnh số';
    let alertHtml = '';

    if (displayStatus === 'approved') {
        headerClass = 'modal-header bg-success text-white';
        alertHtml = `<div class="alert alert-success d-flex align-items-center mb-4"><i class="fas fa-check-circle fa-2x me-3"></i><div><strong>Đã thực hiện thành công</strong><br><small>Tồn kho đã được cập nhật theo các thay đổi trong phiếu.</small></div></div>`;
        if (data.requestedByName) { // Từ yêu cầu
            headerTitle = 'Chi tiết Chỉnh số (từ yêu cầu đã duyệt)';
            infoHtml = `
                <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
                <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
                <div class="col-md-6"><strong>Người duyệt:</strong> ${data.performedByName || data.approvedByName}</div>
                <div class="col-md-6"><strong>Ngày duyệt:</strong> ${approvedDate}</div>
            `;
        } else { // Chỉnh số trực tiếp
            headerTitle = 'Chi tiết Chỉnh số (trực tiếp)';
            infoHtml = `
                <div class="col-md-6"><strong>Người chỉnh số:</strong> ${data.performedByName}</div>
                <div class="col-md-6"><strong>Ngày chỉnh số:</strong> ${approvedDate}</div>
            `;
        }
    } else if (displayStatus === 'rejected') {
        headerClass = 'modal-header bg-danger text-white';
        headerTitle = 'Chi tiết Yêu cầu (đã từ chối)';
        alertHtml = `<div class="alert alert-danger d-flex align-items-center mb-4"><i class="fas fa-exclamation-triangle fa-2x me-3"></i><div><strong>Yêu cầu đã bị từ chối</strong><br><small>Không có thay đổi nào được thực hiện trên tồn kho.</small></div></div>`;
        infoHtml = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
            <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
            <div class="col-md-6"><strong>Người từ chối:</strong> ${data.rejectedByName}</div>
            <div class="col-md-6"><strong>Ngày từ chối:</strong> ${rejectedDate}</div>
            <div class="col-12 mt-2"><strong>Lý do từ chối:</strong><p class="ms-2 mt-1 mb-0 fst-italic bg-danger bg-opacity-10 p-2 rounded text-danger">${data.rejectionReason || 'Không có lý do cụ thể'}</p></div>
        `;
    } else { // pending
        headerTitle = 'Chi tiết Yêu cầu Chỉnh số';
        alertHtml = `<div class="alert alert-warning d-flex align-items-center mb-4"><i class="fas fa-clock me-2"></i><small>Yêu cầu đang chờ được xem xét bởi Super Admin.</small></div>`;
        infoHtml = `
            <div class="col-md-6"><strong>Người yêu cầu:</strong> ${data.requestedByName}</div>
            <div class="col-md-6"><strong>Ngày yêu cầu:</strong> ${requestDate}</div>
        `;
    }

    // --- Tạo bảng danh sách các mã hàng ---
    const itemsHtml = data.items?.map(item => {
        const previousQty = item.previousQuantity !== undefined ? item.previousQuantity : item.currentQuantity;
        const newQty = item.newQuantity !== undefined ? item.newQuantity : item.requestedQuantity;
        const diff = item.adjustment !== undefined ? item.adjustment : (newQty - previousQty);
        const diffClass = diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : 'text-muted';
        const diffSymbol = diff > 0 ? '+' : '';
        return `<tr>
                    <td class="text-center align-middle"><strong>${item.itemCode || item.code}</strong></td>
                    <td class="text-center align-middle">${item.itemName || item.name}</td>
                    <td class="text-center align-middle">${item.location}</td>
                    <td class="text-center align-middle">${previousQty}</td>
                    <td class="text-center align-middle">${newQty}</td>
                    <td class="text-center align-middle ${diffClass}">${diffSymbol}${diff}</td>
                </tr>`;
    }).join('') || '<tr><td colspan="6" class="text-center text-muted">Không có thông tin chi tiết mã hàng.</td></tr>';

    // --- Ghép lại thành HTML cuối cùng ---
    modal.innerHTML = `
        <div class="modal-dialog modal-xl modal-dialog-centered">
            <div class="modal-content">
                <div class="${headerClass}">
                    <h5 class="modal-title"><i class="${status.icon}"></i> ${headerTitle}</h5>
                    <button type="button" class="btn-close ${headerClass.includes('text-white') ? 'btn-close-white' : ''}" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    ${alertHtml}
                    <div class="row mb-3 theme-aware-info-box">
                        <div class="col-md-6"><strong>Lý do chung:</strong> ${data.reason}</div>
                        <div class="col-md-6"><strong>Trạng thái:</strong> <span class="badge ${status.class}">${status.text}</span></div>
                        ${infoHtml}
                    </div>
                    <h6 class="text-muted mb-3"><i class="fas fa-list me-2"></i>Chi tiết các mã hàng thay đổi</h6>
                    <div class="table-responsive">
                        <table class="table table-bordered table-compact">
                            <thead class="table-light">
                                <tr>
                                    <th class="text-center" style="width: 13%">Mã hàng</th>
                                    <th class="text-center" style="width: 35%">Mô tả</th>
                                    <th class="text-center" style="width: 13%">Vị trí</th>
                                    <th class="text-center" style="width: 13%">SL Cũ</th>
                                    <th class="text-center" style="width: 13%">SL Mới/Đề xuất</th>
                                    <th class="text-center" style="width: 13%">Chênh lệch</th>
                                </tr>
                            </thead>
                            <tbody>${itemsHtml}</tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button></div>
            </div>
        </div>
    `;
    return modal;
}

export function loadTransferSection() {
    initializeRealtimeHistoryTable('transfer');
}

function showTransferModal() {
    const lastFocusedElement = document.activeElement;
    const modal = createTransferModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.addEventListener('shown.bs.modal', () => {
        // SỬA LỖI: Đổi ID từ 'transferItemCodeInput' thành 'transferItemSearch'
        document.getElementById('transferItemSearch').focus();
    });

    modal.addEventListener('hidden.bs.modal', () => {
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
        modal.remove();
    });

    bsModal.show();
}

// warehouse.js

function createTransferModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'transferModal';
    modal.setAttribute('tabindex', '-1');

    // THÊM MỚI: Tạo các option cho Dãy, Kệ, Tầng từ layoutConfig
    const aisleOptions = layoutConfig.aisles.map(a => `<option value="${a}">${a}</option>`).join('');
    let bayOptions = '';
    for (let i = 1; i <= layoutConfig.maxBay; i++) {
        bayOptions += `<option value="${i}">Kệ ${i}</option>`;
    }
    let levelOptions = '';
    for (let i = 1; i <= layoutConfig.maxLevel; i++) {
        levelOptions += `<option value="${i}">Tầng ${i}</option>`;
    }

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
                        <div class="form-section-compact">
                            <div class="form-section-header-compact">
                                <i class="fas fa-search"></i> Thông tin hàng hóa
                            </div>
                            <div class="row quick-add-row mb-2">
                                <div class="col-md-4">
                                    <label class="form-label-compact"><i class="fas fa-barcode text-info"></i> Tìm mã hàng *</label>
                                    <div class="autocomplete-container-compact">
                                        <input type="text" class="form-control-compact" id="transferItemSearch" placeholder="Nhập mã hoặc tên..." autocomplete="off">
                                        <div class="suggestion-dropdown-compact" id="transferItemSuggestions" style="display: none;"></div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label-compact"><i class="fas fa-tag text-info"></i> Tên mô tả</label>
                                    <input type="text" class="form-control-compact" id="transferItemName" readonly>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label-compact"><i class="fas fa-map-marker-alt text-info"></i> Vị trí nguồn</label>
                                    <input type="text" class="form-control-compact" id="transferCurrentLocation" readonly>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label-compact"><i class="fas fa-warehouse text-info"></i> Tồn kho tại vị trí</label>
                                    <input type="text" class="form-control-compact" id="transferCurrentStock" readonly>
                                </div>
                            </div>
                            <div class="row quick-add-row mt-3">
                                <div class="col-md-3">
                                    <label class="form-label-compact"><i class="fas fa-sort-numeric-up text-info"></i> Số lượng chuyển *</label>
                                    <input type="number" class="form-control-compact" id="transferQuantity" required min="1" placeholder="0">
                                </div>

                                <!-- === THAY ĐỔI VỊ TRÍ MỚI === -->
                                <div class="col-md-5">
                                    <label class="form-label-compact"><i class="fas fa-map-marker-alt text-success"></i> Đến vị trí mới *</label>
                                    <div class="row">
                                        <div class="col-md-4">
                                        <small class="form-label">Chọn dãy</small>
                                            <select class="form-select-compact" id="transferNewAisle">${aisleOptions}</select>
                                        </div>
                                        <div class="col-md-4">
                                        <small class="form-label">Chọn kệ</small>
                                            <select class="form-select-compact" id="transferNewBay">${bayOptions}</select>
                                        </div>
                                        <div class="col-md-4">
                                        <small class="form-label">Chọn tầng</small>
                                            <select class="form-select-compact" id="transferNewLevel">${levelOptions}</select>
                                        </div>    
                                    </div>
                                </div>
                                <!-- === KẾT THÚC THAY ĐỔI VỊ TRÍ MỚI === -->
                                
                                <div class="col-md-4">
                                    <label class="form-label-compact"><i class="fas fa-sticky-note text-info"></i> Ghi chú</label>
                                    <input type="text" class="form-control-compact" id="transferNote" placeholder="Lý do chuyển...">
                                </div>
                            </div>
                            <input type="hidden" id="sourceInventoryId">
                            <input type="hidden" id="transferItemCode">
                            <input type="hidden" id="transferItemUnit">
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal"><i class="fas fa-times"></i> Hủy</button>
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
    const itemSearchInput = document.getElementById('transferItemSearch');
    if (itemSearchInput) {
        itemSearchInput.addEventListener('input', debounce(handleTransferItemSearch, 300));
        itemSearchInput.addEventListener('blur', () => setTimeout(() => hideSuggestions('transferItemSuggestions'), 200));
    }

    // SỬA LẠI: Gán sự kiện cho các ô mới
    document.getElementById('transferQuantity')?.addEventListener('input', updateTransferSaveButtonState);
    document.getElementById('transferNewAisle')?.addEventListener('change', updateTransferSaveButtonState);
    document.getElementById('transferNewBay')?.addEventListener('change', updateTransferSaveButtonState);
    document.getElementById('transferNewLevel')?.addEventListener('change', updateTransferSaveButtonState);
}

// warehouse.js

async function handleTransferItemSearch(event) {
    const searchTerm = event.target.value.trim();
    const suggestionsContainer = document.getElementById('transferItemSuggestions');
    suggestionsContainer.innerHTML = '';

    if (searchTerm.length < 2) return;

    try {
        // BỎ ĐIỀU KIỆN LỌC 'status' KHỎI CÂU TRUY VẤN
        const baseConstraints = [where('quantity', '>', 0)];
        const codeQuery = query(collection(db, 'inventory'), ...baseConstraints, orderBy('code'), where('code', '>=', searchTerm.toUpperCase()), where('code', '<=', searchTerm.toUpperCase() + '\uf8ff'), limit(10));
        const nameQuery = query(collection(db, 'inventory'), ...baseConstraints, orderBy('name'), where('name', '>=', searchTerm), where('name', '<=', searchTerm + '\uf8ff'), limit(10));

        const [codeSnapshot, nameSnapshot] = await Promise.all([getDocs(codeQuery), getDocs(nameQuery)]);
        const resultsMap = new Map();

        codeSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));
        nameSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));

        // THÊM: Lọc kết quả trên client để loại bỏ mã hàng đã xóa
        const activeResults = Array.from(resultsMap.values())
            .filter(item => item.status !== 'archived');

        if (activeResults.length === 0) {
            suggestionsContainer.style.display = 'none';
            return;
        }

        suggestionsContainer.innerHTML = activeResults.map(item => {
            const itemJsonString = JSON.stringify(item).replace(/'/g, "\\'");
            return `<div class="suggestion-item-compact" onclick='selectItemForTransfer(${itemJsonString})'>
                        <strong>${item.code}</strong> - ${item.name} (Vị trí: ${item.location} | Tồn: ${item.quantity})
                    </div>`;
        }).join('');
        suggestionsContainer.style.display = 'block';
    } catch (error) {
        console.error("Lỗi tìm kiếm hàng chuyển kho:", error);
    }
}


// Thêm hàm MỚI này vào warehouse.js
window.selectItemForTransfer = function (item) {
    // Điền thông tin vào các trường của form
    document.getElementById('sourceInventoryId').value = item.id;
    document.getElementById('transferItemSearch').value = `${item.code} - ${item.name}`;
    document.getElementById('transferItemCode').value = item.code;
    document.getElementById('transferItemName').value = item.name;
    document.getElementById('transferItemUnit').value = item.unit;
    document.getElementById('transferCurrentLocation').value = item.location;
    document.getElementById('transferCurrentStock').value = item.quantity;

    const quantityInput = document.getElementById('transferQuantity');
    quantityInput.max = item.quantity;

    hideSuggestions('transferItemSuggestions');
    quantityInput.focus();
};

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

// Thay thế hàm này trong warehouse.js
async function handleTransferItemCodeInput(event) {
    const code = event.target.value.trim().toUpperCase();
    event.target.value = code;

    const locationSection = document.getElementById('transferLocationSection');
    const locationList = document.getElementById('transferLocationList');
    const detailsSection = document.getElementById('transferDetailsSection');

    // Reset giao diện
    locationSection.style.display = 'none';
    detailsSection.style.display = 'none';
    locationList.innerHTML = '';
    updateWorkflowStep('transferSelectStep', false);
    updateWorkflowStep('transferDetailsStep', false);

    if (code.length < 2) return;

    try {
        const inventoryQuery = query(
            collection(db, 'inventory'),
            where('code', '==', code),
            where('status', '!=', 'archived'),
            where('quantity', '>', 0)
        );
        const snapshot = await getDocs(inventoryQuery);

        if (snapshot.empty) {
            locationList.innerHTML = '<div class="col-12"><p class="text-danger p-2">Không tìm thấy mã hàng hoặc đã hết hàng.</p></div>';
            locationSection.style.display = 'block';
        } else if (snapshot.docs.length === 1) {
            // Nếu chỉ có 1 vị trí, tự động chọn luôn cho người dùng
            const doc = snapshot.docs[0];
            selectLocationForTransfer(doc.id, doc.data());
        } else {
            // Nếu có nhiều vị trí, hiển thị danh sách để chọn
            snapshot.docs.forEach(doc => {
                const locationCard = createLocationCard(doc.id, doc.data(), 'transfer');
                locationList.appendChild(locationCard);
            });
            locationSection.style.display = 'block';
            updateWorkflowStep('transferSelectStep', true);
        }
    } catch (error) {
        console.error("Lỗi tìm kiếm hàng để chuyển:", error);
        showToast('Lỗi khi tìm kiếm mã hàng', 'danger');
    }
}

window.selectLocationForTransfer = function (docId, data) {
    // Đánh dấu thẻ được chọn
    document.querySelectorAll('.location-card').forEach(card => {
        card.classList.remove('selected');
    });
    const clickedCard = document.querySelector(`[data-doc-id="${docId}"][data-target="transfer"]`);
    if (clickedCard) {
        clickedCard.classList.add('selected');
    }

    // Điền thông tin vào form chi tiết
    document.getElementById('transferItemName').value = data.name;
    document.getElementById('transferCurrentLocation').value = data.location;
    document.getElementById('sourceInventoryId').value = docId;

    const quantityInput = document.getElementById('transferQuantity');
    quantityInput.max = data.quantity;

    // Hiển thị form chi tiết và ẩn danh sách chọn
    document.getElementById('transferDetailsSection').style.display = 'block';
    document.getElementById('transferLocationSection').style.display = 'none';
    updateWorkflowStep('transferSelectStep', true);
    updateWorkflowStep('transferDetailsStep', true);

    quantityInput.focus();
}

// warehouse.js

window.saveTransfer = async function () {
    try {
        const sourceInventoryId = document.getElementById('sourceInventoryId').value;
        const transferQuantity = parseInt(document.getElementById('transferQuantity').value);
        const note = document.getElementById('transferNote').value;
        const currentLocation = document.getElementById('transferCurrentLocation').value;
        const currentStock = parseInt(document.getElementById('transferCurrentStock').value);

        // SỬA LẠI: Lấy giá trị từ 3 ô chọn vị trí mới
        const aisle = document.getElementById('transferNewAisle').value;
        const bay = document.getElementById('transferNewBay').value;
        const level = document.getElementById('transferNewLevel').value;

        // SỬA LẠI: Validation cho vị trí mới
        if (!aisle || !bay || !level) {
            return showToast('Vui lòng chọn đầy đủ thông tin vị trí mới.', 'warning');
        }

        // SỬA LẠI: Tạo chuỗi vị trí mới
        const newLocation = `${aisle}${bay}-${level.toString().padStart(2, '0')}`;

        // Validation (phần còn lại giữ nguyên)
        if (!sourceInventoryId) {
            showToast('Vui lòng chọn một mã hàng hợp lệ từ danh sách gợi ý.', 'warning');
            return;
        }
        if (isNaN(transferQuantity) || transferQuantity <= 0) {
            showToast('Vui lòng nhập số lượng chuyển hợp lệ.', 'warning');
            return;
        }
        if (newLocation === currentLocation) {
            showToast('Vị trí mới phải khác vị trí hiện tại.', 'warning');
            return;
        }
        if (transferQuantity > currentStock) {
            showToast(`Số lượng chuyển (${transferQuantity}) vượt quá tồn kho tại vị trí (${currentStock}).`, 'danger');
            return;
        }

        const confirmed = await showConfirmation(
            'Xác nhận chuyển kho',
            `Bạn có chắc muốn chuyển ${transferQuantity} mã hàng từ <strong>${currentLocation}</strong> đến <strong>${newLocation}</strong>?`,
            'Chuyển kho', 'Hủy', 'info'
        );
        if (!confirmed) return;

        const sourceDocRef = doc(db, 'inventory', sourceInventoryId);
        const sourceDocSnap = await getDoc(sourceDocRef);
        if (!sourceDocSnap.exists()) {
            showToast('Không tìm thấy thông tin tồn kho nguồn.', 'danger');
            return;
        }
        const sourceData = sourceDocSnap.data();

        const batch = writeBatch(db);
        batch.update(sourceDocRef, { quantity: increment(-transferQuantity) });

        const destQuery = query(collection(db, 'inventory'), where('code', '==', sourceData.code), where('location', '==', newLocation), limit(1));
        const destSnapshot = await getDocs(destQuery);

        if (!destSnapshot.empty) {
            const destDocRef = destSnapshot.docs[0].ref;
            batch.update(destDocRef, { quantity: increment(transferQuantity) });
        } else {
            const newInventoryRef = doc(collection(db, 'inventory'));
            batch.set(newInventoryRef, {
                ...sourceData,
                location: newLocation,
                quantity: transferQuantity,
                createdAt: serverTimestamp()
            });
        }

        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'transfer', itemCode: sourceData.code, itemName: sourceData.name,
            quantity: transferQuantity, unit: sourceData.unit,
            fromLocation: currentLocation, toLocation: newLocation, note: note,
            performedBy: currentUser.uid, performedByName: currentUser.name,
            date: serverTimestamp(), timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Chuyển kho thành công!', 'success');
        const modal = document.getElementById('transferModal');
        if (modal) {
            bootstrap.Modal.getInstance(modal).hide();
        }
        loadTransferHistory();

    } catch (error) {
        console.error('Lỗi khi lưu chuyển kho:', error);
        showToast('Lỗi nghiêm trọng khi chuyển kho.', 'danger');
    }
};


function initializeDirectAdjustSection() {
    document.getElementById('addAdjustBtn')?.addEventListener('click', showDirectAdjustModal);
    document.getElementById('clearAdjustFilter')?.addEventListener('click', clearDirectAdjustFilter);
}

// Thay thế hàm này trong warehouse.js
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
                        <strong>Cảnh báo:</strong> Thao tác này sẽ thực hiện chỉnh số ngay lập tức và không cần duyệt.
                    </div>
                    
                    <form id="directAdjustForm" onsubmit="return false;">
                        <div class="form-section-compact">
                            <div class="form-section-header-compact" style="color: #dc3545;">
                                <i class="fas fa-search"></i> Thông tin hàng hóa
                            </div>
                            <div class="row quick-add-row mb-2">
                                <div class="col-md-4">
                                    <label class="form-label-compact"><i class="fas fa-barcode text-danger"></i> Tìm mã hàng *</label>
                                    <div class="autocomplete-container-compact">
                                        <input type="text" class="form-control-compact" id="directAdjustItemSearch" placeholder="Nhập mã hoặc tên..." autocomplete="off">
                                        <div class="suggestion-dropdown-compact" id="directAdjustItemSuggestions" style="display: none;"></div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label-compact"><i class="fas fa-tag text-danger"></i> Tên mô tả</label>
                                    <input type="text" class="form-control-compact" id="directAdjustItemName" readonly>
                                </div>
                                <div class="col-md-2">
                                    <label class="form-label-compact"><i class="fas fa-map-marker-alt text-danger"></i> Vị trí</label>
                                    <input type="text" class="form-control-compact" id="directAdjustCurrentLocation" readonly>
                                </div>
                                <div class="col-md-3">
                                    <label class="form-label-compact"><i class="fas fa-warehouse text-danger"></i> Tồn kho hiện tại</label>
                                    <input type="text" class="form-control-compact" id="directAdjustCurrentStock" readonly>
                                </div>
                            </div>
                            <div class="row quick-add-row mt-3">
                                <div class="col-md-6">
                                    <label class="form-label-compact"><i class="fas fa-sort-numeric-up text-danger"></i> Số lượng thực tế (mới) *</label>
                                    <input type="number" class="form-control-compact" id="directAdjustNewQuantity" required min="0" placeholder="0">
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label-compact"><i class="fas fa-comment text-danger"></i> Lý do điều chỉnh *</label>
                                    <input type="text" class="form-control-compact" id="directAdjustReason" required placeholder="VD: Kiểm kê thực tế, hàng hỏng...">
                                </div>
                            </div>
                            <input type="hidden" id="directAdjustInventoryId">
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal"><i class="fas fa-times"></i> Hủy</button>
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
    const itemSearchInput = document.getElementById('directAdjustItemSearch');
    if (itemSearchInput) {
        itemSearchInput.addEventListener('input', debounce(handleDirectAdjustItemSearch, 300));
        itemSearchInput.addEventListener('blur', () => setTimeout(() => hideSuggestions('directAdjustItemSuggestions'), 200));
    }

    document.getElementById('directAdjustNewQuantity')?.addEventListener('input', updateDirectAdjustSaveButtonState);
    document.getElementById('directAdjustReason')?.addEventListener('input', updateDirectAdjustSaveButtonState);
}

function updateDirectAdjustSaveButtonState() {
    const saveBtn = document.getElementById('confirmDirectAdjustBtn');
    if (!saveBtn) return;

    const hasItem = document.getElementById('directAdjustInventoryId').value;
    const hasQuantity = document.getElementById('directAdjustNewQuantity').value;
    const hasReason = document.getElementById('directAdjustReason').value.trim();

    saveBtn.disabled = !(hasItem && hasQuantity && hasReason);
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
            locationList.innerHTML = '<div class="col-12"><p class="text-danger p-2">Không tìm thấy mã hàng với mã này.</p></div>';
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

window.showAdjustRequestModal = showAdjustRequestModal;
window.showDirectAdjustModal = showDirectAdjustModal;
window.downloadRequestAdjustTemplate = downloadRequestAdjustTemplate;
window.downloadAdjustTemplate = downloadAdjustTemplate;

export function loadAdjustSection() {
    const content = document.getElementById('adjustContent');
    if (!content) return;
    
    // Chỉ render giao diện tĩnh và gán sự kiện MỘT LẦN DUY NHẤT
    if (!window.adjustUiInitialized) {
        renderAdjustUI(currentUser.role);
        initializeAdjustFilters();
        window.adjustUiInitialized = true;
    }
    
    // Luôn gọi hàm tải dữ liệu mỗi khi vào tab
    loadAdjustData(); 
}

function showAdjustRequestModal() {
    currentRequestItems = [];
    const modal = createAdjustRequestModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    modal.addEventListener('shown.bs.modal', () => document.getElementById('requestItemSearch')?.focus());
    modal.addEventListener('hidden.bs.modal', () => modal.remove());
    bsModal.show();
}

function showDirectAdjustModal() {
    const modal = createDirectAdjustModal();
    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    modal.addEventListener('shown.bs.modal', () => document.getElementById('directAdjustItemSearch')?.focus());
    modal.addEventListener('hidden.bs.modal', () => modal.remove());
    bsModal.show();
}

async function handleDirectAdjustItemSearch(event) {
    const searchTerm = event.target.value.trim();
    const suggestionsContainer = document.getElementById('directAdjustItemSuggestions');
    suggestionsContainer.innerHTML = '';

    if (searchTerm.length < 2) return;

    try {
        // BỎ ĐIỀU KIỆN LỌC 'status' KHỎI CÂU TRUY VẤN
        const codeQuery = query(collection(db, 'inventory'), orderBy('code'), where('code', '>=', searchTerm.toUpperCase()), where('code', '<=', searchTerm.toUpperCase() + '\uf8ff'), limit(10));
        const nameQuery = query(collection(db, 'inventory'), orderBy('name'), where('name', '>=', searchTerm), where('name', '<=', searchTerm + '\uf8ff'), limit(10));

        const [codeSnapshot, nameSnapshot] = await Promise.all([getDocs(codeQuery), getDocs(nameQuery)]);
        const resultsMap = new Map();

        codeSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));
        nameSnapshot.forEach(doc => resultsMap.set(doc.id, { id: doc.id, ...doc.data() }));

        // THÊM: Lọc kết quả trên client để loại bỏ mã hàng đã xóa
        const activeResults = Array.from(resultsMap.values())
            .filter(item => item.status !== 'archived');

        if (activeResults.length === 0) {
            suggestionsContainer.style.display = 'none';
            return;
        }

        suggestionsContainer.innerHTML = activeResults.map(item => {
            const itemJsonString = JSON.stringify(item).replace(/'/g, "\\'");
            return `<div class="suggestion-item-compact" onclick='selectItemForDirectAdjust(${itemJsonString})'>
                        <strong>${item.code}</strong> - ${item.name} (Vị trí: ${item.location} | Tồn: ${item.quantity})
                    </div>`;
        }).join('');
        suggestionsContainer.style.display = 'block';
    } catch (error) {
        console.error("Lỗi tìm kiếm hàng để chỉnh số:", error);
    }
}

window.selectItemForDirectAdjust = function (item) {
    // Điền thông tin vào các trường của form
    document.getElementById('directAdjustInventoryId').value = item.id;
    document.getElementById('directAdjustItemSearch').value = `${item.code} - ${item.name}`;
    document.getElementById('directAdjustItemName').value = item.name;
    document.getElementById('directAdjustCurrentLocation').value = item.location;
    document.getElementById('directAdjustCurrentStock').value = item.quantity;

    const quantityInput = document.getElementById('directAdjustNewQuantity');
    quantityInput.value = item.quantity; // Tự điền số lượng hiện tại

    hideSuggestions('directAdjustItemSuggestions');
    quantityInput.focus();
    quantityInput.select();
};

// Thay thế hàm này trong warehouse.js
function initializeAdjustFilters() {
    // Guard clause to prevent attaching listeners multiple times.
    if (window.adjustFiltersInitialized) return;

    const filterInputs = ['adjustFromDate', 'adjustToDate', 'adjustStatusFilter', 'adjustItemCodeFilter'];
    filterInputs.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            const eventType = id === 'adjustItemCodeFilter' ? 'input' : 'change';
            // The handler now ONLY calls loadAdjustData.
            const handler = () => loadAdjustData();
            element.addEventListener(eventType, eventType === 'input' ? debounce(handler, 500) : handler);
        }
    });
    window.adjustFiltersInitialized = true;
}

// File: js/warehouse.js

async function loadAdjustData() {
    if (unsubscribeAdjust) unsubscribeAdjust();

    try {
        // === SỬA LỖI QUAN TRỌNG: Chỉ lấy về các yêu cầu đang chờ hoặc đã từ chối ===
        const requestsQuery = query(collection(db, 'adjustment_requests'), where('status', 'in', ['pending', 'rejected']));
        const transactionsQuery = query(collection(db, 'transactions'), where('type', '==', 'adjust'));

        const handleDataUpdate = async () => {
            try {
                const [requestsSnapshot, transactionsSnapshot] = await Promise.all([
                    getDocs(requestsQuery),
                    getDocs(transactionsQuery)
                ]);

                // Lấy các giá trị bộ lọc từ giao diện
                const fromDate = document.getElementById('adjustFromDate')?.value;
                const toDate = document.getElementById('adjustToDate')?.value;
                const statusFilter = document.getElementById('adjustStatusFilter')?.value;
                const itemCodeFilter = document.getElementById('adjustItemCodeFilter')?.value.toLowerCase();

                let requests = requestsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), dataType: 'request' }));
                let transactions = transactionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), dataType: 'transaction' }));

                let allData = [...requests, ...transactions];

                // Lọc dữ liệu phía client
                if (fromDate || toDate || statusFilter || itemCodeFilter) {
                    allData = allData.filter(doc => {
                        if (!doc.timestamp) return false;
                        const docDate = doc.timestamp.toDate();
                        if (fromDate && docDate < new Date(fromDate)) return false;
                        if (toDate) {
                            const endDate = new Date(toDate);
                            endDate.setHours(23, 59, 59, 999);
                            if (docDate > endDate) return false;
                        }

                        // Logic lọc trạng thái (giờ đã đơn giản hơn)
                        const docStatus = doc.dataType === 'transaction' ? 'approved' : doc.status;
                        if (statusFilter && docStatus !== statusFilter) return false;
                        
                        if (itemCodeFilter) {
                            const hasMatchingItem = doc.items?.some(item => (item.itemCode || item.code)?.toLowerCase().includes(itemCodeFilter));
                            if (!hasMatchingItem) return false;
                        }
                        
                        return true;
                    });
                }
                
                allData.sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0));
                
                sectionState.adjust.data = allData;
                renderPaginatedHistoryTable('adjust');

            } catch (error) {
                console.error("Lỗi khi xử lý dữ liệu chỉnh số:", error);
            }
        };

        const unsubscribeRequests = onSnapshot(requestsQuery, handleDataUpdate);
        const unsubscribeTransactions = onSnapshot(transactionsQuery, handleDataUpdate);

        unsubscribeAdjust = () => {
            unsubscribeRequests();
            unsubscribeTransactions();
        };

        handleDataUpdate();

    } catch (error) {
        console.error('Lỗi thiết lập lắng nghe mục Chỉnh số:', error);
    }
}



function renderAdjustUI(userRole) {
    const content = document.getElementById('adjustContent');
    if (!content) return;

    // --- Render các nút bấm tùy theo vai trò ---
    const buttonsHtml = `
        <div class="d-flex justify-content-between align-items-center mb-3">
            <div>
                ${userRole === 'admin' ? `
                    <button class="btn btn-info me-2" id="downloadRequestAdjustTemplate">
                        <i class="fas fa-download"></i> Tải mẫu Excel Yêu cầu
                    </button>
                    <button class="btn btn-warning me-2" id="importRequestAdjustExcel">
                        <i class="fas fa-file-excel"></i> Nhập từ Excel
                    </button>
                    <button class="btn btn-primary" id="addAdjustRequestBtn" onclick="showAdjustRequestModal()">
                        <i class="fas fa-plus"></i> Tạo yêu cầu chỉnh số
                    </button>
                ` : ''}
                ${userRole === 'super_admin' ? `
                    <button class="btn btn-info me-2" id="downloadAdjustTemplate">
                        <i class="fas fa-download"></i> Tải mẫu Excel Chỉnh số
                    </button>
                    <button class="btn btn-warning me-2" id="importAdjustExcel">
                        <i class="fas fa-file-excel"></i> Nhập từ Excel
                    </button>
                    <button class="btn btn-danger" id="addAdjustBtn" onclick="showDirectAdjustModal()">
                        <i class="fas fa-plus"></i> Chỉnh sửa tồn kho trực tiếp
                    </button>
                ` : ''}
            </div>
        </div>
    `;

    // --- Render bộ lọc ---
    const filterHtml = `
        <div class="card mb-3">
            <div class="card-body">
                <h6 class="card-title">Bộ lọc</h6>
                <div class="row align-items-end">
                    <div class="col-md-3"><label class="form-label">Từ ngày</label><input type="date" class="form-control" id="adjustFromDate"></div>
                    <div class="col-md-3"><label class="form-label">Đến ngày</label><input type="date" class="form-control" id="adjustToDate"></div>
                    <div class="col-md-3"><label class="form-label">Trạng thái</label>
                        <select class="form-select" id="adjustStatusFilter">
                            <option value="">Tất cả</option>
                            <option value="pending">Chờ duyệt</option>
                            <option value="approved">Đã duyệt</option>
                            <option value="rejected">Từ chối</option>
                        </select>
                    </div>
                    <div class="col-md-3"><label class="form-label">Mã hàng</label><input type="text" class="form-control" id="adjustItemCodeFilter" placeholder="Tìm mã hàng..."></div>
                </div>
            </div>
        </div>
    `;

    // Set the static content for the page.
    content.innerHTML = buttonsHtml + filterHtml + '<div id="adjustTableContainer"></div>';
}

function renderAdjustTable(data) {
    const tableContainer = document.getElementById('adjustTableContainer');
    if (!tableContainer) return;
    if (data.length === 0) {
        tableContainer.innerHTML = '<p class="text-muted">Không tìm thấy dữ liệu phù hợp.</p>';
    } else {
        // Giao toàn bộ việc render cho hàm chung
        renderPaginatedHistoryTable('adjust');
    }
}

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
        select.innerHTML = '<option value="">-- Chọn mã hàng --</option>';

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
                    const items = data.items || [];
                    
                    if (items.length === 1) {
                        const item = items[0];
                        
                        // === SỬA LỖI Ở ĐÂY: Kiểm tra cả hai bộ tên trường ===
                        const previousQty = item.previousQuantity !== undefined ? item.previousQuantity : item.currentQuantity;
                        const newQty = item.newQuantity !== undefined ? item.newQuantity : item.requestedQuantity;
                        // ====================================================

                        details = `
                            <span>
                                Điều chỉnh ${item.itemCode || 'N/A'} 
                                <span class="text-muted">(${(previousQty !== undefined ? previousQty : 0)} → ${(newQty !== undefined ? newQty : 0)})</span>
                            </span>
                        `;
                    } else if (items.length > 1) {
                        details = `
                            <span>
                                Điều chỉnh ${items[0].itemCode || 'N/A'} 
                                <span class="text-muted">(và ${items.length - 1} mã khác)</span>
                            </span>
                        `;
                    } else {
                        details = `<span>Phiếu chỉnh số không có chi tiết</span>`;
                    }

                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewAdjustRequestDetails('${docId}')">
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
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewDeletionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'export_deleted':
                    details = `Xóa phiếu xuất: ${data.deletedExportNumber || 'N/A'}`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewDeletionDetails('${docId}')">
                        <i class="fas fa-eye"></i> Xem
                    </button>`;
                    break;

                case 'transfer_deleted':
                    details = `Xóa chuyển kho: ${data.deletedItemCode || 'N/A'} (${data.deletedQuantity || 0})`;
                    viewButton = `<button class="btn btn-info btn-sm" onclick="viewDeletionDetails('${docId}')">
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

window.viewDeletionDetails = async function (transactionId) {
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

window.viewEditDetails = async function (transactionId) {
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

    switch (data.type) {
        case 'adjust_deleted':
            modalTitle = 'Chi tiết Xóa Phiếu Chỉnh Số';
            alertMainText = 'Phiếu chỉnh số đã bị xóa';
            alertSubText = 'Tồn kho đã được khôi phục về số lượng ban đầu.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Mã hàng:</strong> ${data.deletedItemCode}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
            `;
            detailsTitle = 'Thông tin phiếu chỉnh số đã hủy';
            detailsContentHtml = `
                <div class="row text-center">
                    <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Số lượng ban đầu</h6><p class="card-text fs-4">${data.deletedPreviousQuantity}</p><small class="text-success">✓ Đã khôi phục</small></div></div></div>
                    <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Số lượng đã chỉnh</h6><p class="card-text fs-4 text-muted"><s>${data.deletedNewQuantity}</s></p><small class="text-danger">✗ Đã hủy</small></div></div></div>
                    <div class="col-4"><div class="card h-100"><div class="card-body"><h6 class="card-title text-muted">Chênh lệch</h6><p class="card-text fs-4 text-muted"><s>${data.deletedAdjustment >= 0 ? '+' : ''}${data.deletedAdjustment}</s></p><small class="text-danger">✗ Đã hủy</small></div></div></div>
                </div>`;
            reasonHtml = `<p class="ms-2 mt-1 mb-0 fst-italic theme-aware-inset-box p-2 rounded">${data.deletedReason}</p>`;
            impactHtml = `<strong>Tác động:</strong> Tồn kho đã được khôi phục về ${data.revertedTo}.`;
            break;

        case 'import_deleted':
            const deletedImportItems = data.deletedItems || [];
            modalTitle = 'Chi tiết Xóa Phiếu Nhập';
            alertMainText = 'Phiếu nhập đã bị xóa';
            alertSubText = 'Số lượng hàng hóa trong phiếu đã được thu hồi khỏi tồn kho.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Số phiếu đã xóa:</strong> ${data.deletedImportNumber}</div>
                <div class="col-md-6"><strong>Nhà cung cấp gốc:</strong> ${data.deletedSupplier || 'N/A'}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
            `;
            detailsTitle = 'Các mã hàng đã được TRỪ khỏi tồn kho';
            detailsContentHtml = `
                <div class="table-responsive" style="max-height: 200px;">
                    <table class="table table-sm table-bordered">
                        <thead class="table-light"><tr class="text-center"><th>Mã hàng</th><th>Tên</th><th>Số lượng thu hồi</th></tr></thead>
                        <tbody>
                            ${deletedImportItems.map(item => `<tr><td>${item.code}</td><td>${item.name}</td><td class="text-danger fw-bold">-${item.quantity}</td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
            impactHtml = `<strong>Tác động:</strong> Toàn bộ số lượng từ phiếu nhập này đã được <strong>trừ</strong> khỏi tồn kho hệ thống.`;
            break;
        case 'export_deleted':
            const deletedExportItems = data.deletedItems || [];
            modalTitle = 'Chi tiết Xóa Phiếu Xuất';
            alertMainText = 'Phiếu xuất đã bị xóa';
            alertSubText = 'Số lượng hàng hóa trong phiếu đã được hoàn lại vào tồn kho.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Số phiếu đã xóa:</strong> ${data.deletedExportNumber}</div>
                <div class="col-md-6"><strong>Người nhận gốc:</strong> ${data.deletedRecipient || 'N/A'}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
            `;
            detailsTitle = 'Các mã hàng đã được HOÀN LẠI vào tồn kho';
            detailsContentHtml = `
                <div class="table-responsive" style="max-height: 200px;">
                    <table class="table table-sm table-bordered">
                        <thead class="table-light"><tr class="text-center"><th>Mã hàng</th><th>Tên</th><th>Số lượng hoàn lại</th></tr></thead>
                        <tbody>
                            ${deletedExportItems.map(item => `<tr><td>${item.code}</td><td>${item.name}</td><td class="text-success fw-bold">+${item.quantity}</td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
            impactHtml = `<strong>Tác động:</strong> Toàn bộ số lượng từ phiếu xuất này đã được <strong>hoàn trả</strong> vào tồn kho hệ thống.`;
            break;
        case 'transfer_deleted':
            modalTitle = 'Chi tiết Xóa Phiếu Chuyển Kho';
            alertMainText = 'Phiếu chuyển kho đã bị xóa';
            alertSubText = 'Số lượng đã được hoàn trả về vị trí ban đầu.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Mã hàng:</strong> ${data.deletedItemCode}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
                <div class="col-md-6"><strong>Thời gian xóa:</strong> ${date}</div>
            `;
            detailsTitle = 'Thông tin hoàn tác chuyển kho';
            detailsContentHtml = `
                <div class="row text-center">
                    <div class="col-5">
                        <div class="card h-100">
                            <div class="card-body">
                                <h6 class="card-title text-muted">VỊ TRÍ NGUỒN</h6>
                                <p class="card-text fs-4 fw-bold">${data.deletedFromLocation}</p>
                                <strong class="text-success">+${data.deletedQuantity}</strong>
                                <br><small class="text-success">✓ Đã hoàn trả</small>
                            </div>
                        </div>
                    </div>
                    <div class="col-2 d-flex align-items-center justify-content-center">
                        <i class="fas fa-undo fa-2x text-primary"></i>
                    </div>
                    <div class="col-5">
                        <div class="card h-100">
                            <div class="card-body">
                                <h6 class="card-title text-muted">VỊ TRÍ ĐÍCH</h6>
                                <p class="card-text fs-4 fw-bold">${data.deletedToLocation}</p>
                                <strong class="text-danger">-${data.deletedQuantity}</strong>
                                <br><small class="text-danger">✗ Đã thu hồi</small>
                            </div>
                        </div>
                    </div>
                </div>`;
            impactHtml = `<strong>Tác động:</strong> Số lượng đã được hoàn trả về vị trí <strong>${data.deletedFromLocation}</strong> và thu hồi từ vị trí <strong>${data.deletedToLocation}</strong>.`;
            break;

        case 'inventory_archived':
            modalTitle = 'Chi tiết Xóa (Lưu trữ) mã hàng';
            alertMainText = 'Mã hàng đã được lưu trữ';
            alertSubText = 'Mã hàng này đã bị ẩn khỏi các danh sách và tìm kiếm thông thường.';
            generalInfoHtml = `
                <div class="col-md-6"><strong>Mã hàng:</strong> ${data.itemCode}</div>
                <div class="col-md-6"><strong>Người xóa:</strong> ${data.performedByName}</div>
                <div class="col-md-6"><strong>Thời gian xóa:</strong> ${date}</div>
            `;
            detailsTitle = 'Thông tin chi tiết';
            detailsContentHtml = `<p class="p-3 theme-aware-inset-box rounded border">${data.details}</p>`;
            impactHtml = '<strong>Tác động:</strong> mã hàng này không còn hiển thị trong danh sách tồn kho chính.';
            break;
    }

    // --- Xây dựng HTML cuối cùng từ các mảnh đã chuẩn bị ---
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
        items_changed: 'Số lượng mã hàng',
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
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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

window.viewOriginalTransaction = function (transactionId, type) {
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
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
                        <p class="ms-2 mt-1 mb-0 fst-italic theme-aware-inset-box p-2 rounded">${data.deletedReason}</p>
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
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
                        <p class="ms-2 mt-1 mb-0 fst-italic theme-aware-inset-box p-2 rounded">${data.reason}</p>
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
    if (unsubscribeAllHistory) {
        unsubscribeAllHistory();
    }

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

        let historyQuery;
        const constraints = [];
        if (filterType !== 'all' && transactionTypeMap[filterType]) {
            constraints.push(where('type', 'in', transactionTypeMap[filterType]));
        }
        if (fromDate) constraints.push(where('timestamp', '>=', new Date(fromDate)));
        if (toDate) {
            const endDate = new Date(toDate);
            endDate.setHours(23, 59, 59, 999);
            constraints.push(where('timestamp', '<=', endDate));
        }
        constraints.push(orderBy('timestamp', 'desc'));
        historyQuery = query(collection(db, 'transactions'), ...constraints);

        unsubscribeAllHistory = onSnapshot(historyQuery, (snapshot) => {
            let docs = snapshot.docs;
            if (itemCodeFilter) {
                docs = docs.filter(doc => {
                    const data = doc.data();
                    const codeToCheck = [data.itemCode, data.deletedItemCode].filter(Boolean).map(c => c.toLowerCase());
                    if (codeToCheck.some(c => c.includes(itemCodeFilter))) return true;
                    if (data.items?.some(item => item.code?.toLowerCase().includes(itemCodeFilter))) return true;
                    if (data.deletedItems?.some(item => item.code?.toLowerCase().includes(itemCodeFilter))) return true;
                    return false;
                });
            }

            const content = document.getElementById('historyContent');
            if (!content) return;
             if (docs.length === 0) {
            // Luôn sử dụng mẫu chung
            content.innerHTML = '<p class="text-muted">Không tìm thấy dữ liệu phù hợp.</p>';
        } else {
            // Nếu có dữ liệu thì mới gọi hàm tạo bảng
            createHistoryPagination(docs, content);
        }
        }, (error) => {
            console.error("Lỗi lắng nghe lịch sử chung:", error);
        });

    } catch (error) {
        console.error('Lỗi tải lịch sử giao dịch:', error);
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
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
                            <p class="ms-2 mt-1 mb-0 fst-italic theme-aware-inset-box p-2 rounded">${data.note}</p>
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

function initializeRealtimeHistoryTable(sectionName) {
    if (historyListeners[sectionName]) historyListeners[sectionName]();

    const config = historyConfig[sectionName];
    if (!config) return;

    // Tạo cấu trúc bảng một lần (trừ mục adjust đã có UI riêng)
    if (sectionName !== 'adjust') {
        const content = document.getElementById(config.contentId);
        if (content) {
            content.innerHTML = `
                <table class="table table-striped table-compact">
                    ${config.tableHeader}
                    <tbody id="${config.tableBodyId}"></tbody>
                </table>
                <div id="${config.paginationContainerId}"></div>`;
        }
    }

    const renderCallback = (docs) => {
        sectionState[sectionName].data = docs;
        renderPaginatedHistoryTable(sectionName);
    };

    if (config.isComplex) {
        historyListeners[sectionName] = initializeAdjustDataListener(renderCallback);
    } else {
        const finalConstraints = [...config.baseConstraints, orderBy('timestamp', 'desc')];
        const historyQuery = query(collection(db, config.collection), ...finalConstraints);
        historyListeners[sectionName] = onSnapshot(historyQuery, (snapshot) => {
            renderCallback(snapshot.docs);
        }, (error) => console.error(`Lỗi listener cho ${sectionName}:`, error));
    }
}

// Hàm lắng nghe riêng cho mục Chỉnh số
function initializeAdjustDataListener(callback) {
    const requestsQuery = query(collection(db, 'adjustment_requests'), where('status', 'in', ['pending', 'rejected']));
    const transactionsQuery = query(collection(db, 'transactions'), where('type', '==', 'adjust'));

    const unsubscribeRequests = onSnapshot(requestsQuery, handleSnapshots);
    const unsubscribeTransactions = onSnapshot(transactionsQuery, handleSnapshots);
    
    function handleSnapshots() {
        Promise.all([getDocs(requestsQuery), getDocs(transactionsQuery)]).then(([requestsSnapshot, transactionsSnapshot]) => {
            let requests = requestsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), dataType: 'request' }));
            let transactions = transactionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), dataType: 'transaction' }));
            let allData = [...requests, ...transactions].sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0));
            callback(allData);
        });
    }

    return () => {
        unsubscribeRequests();
        unsubscribeTransactions();
    };
}

function renderPaginatedHistoryTable(sectionName) {
    const config = historyConfig[sectionName];
    if (!config) return;

    const state = sectionState[sectionName];
    const itemsPerPage = 15;
    
    // Lấy giá trị filter từ DOM một cách an toàn
    const getFilterValue = (id) => document.getElementById(id)?.value || '';
    const fromDateFilter = getFilterValue(`${sectionName}FromDate`);
    const toDateFilter = getFilterValue(`${sectionName}ToDate`);
    const itemCodeFilter = getFilterValue(`${sectionName}ItemCodeFilter`).toLowerCase();
    const statusFilter = getFilterValue(`${sectionName}StatusFilter`);
    
    // Lọc dữ liệu phía client dựa trên filter
    let filteredData = state.data.filter(docSnapshot => {
        const data = docSnapshot.data ? docSnapshot.data() : docSnapshot;
        let codeMatch = true, dateMatch = true, statusMatch = true;

        // Lọc theo ngày (chung cho tất cả)
        if (data.timestamp) {
            const docDate = data.timestamp.toDate();
            if (fromDateFilter && docDate < new Date(fromDateFilter)) dateMatch = false;
            if (toDateFilter) {
                const endDate = new Date(toDateFilter);
                endDate.setHours(23, 59, 59, 999);
                if (docDate > endDate) dateMatch = false;
            }
        }
        
        // SỬA LỖI: Logic lọc theo Mã hàng được tách riêng cho từng section
        if (itemCodeFilter) {
            switch (sectionName) {
                case 'import':
                case 'export':
                case 'adjust': // Chỉnh số cũng dùng cấu trúc 'items'
                    codeMatch = data.items?.some(item => (item.itemCode || item.code)?.toLowerCase().includes(itemCodeFilter));
                    break;
                case 'transfer':
                    codeMatch = data.itemCode?.toLowerCase().includes(itemCodeFilter);
                    break;
            }
        }

        // SỬA LỖI: Logic lọc theo Trạng thái được tách riêng cho từng section
        if (statusFilter) {
            switch (sectionName) {
                case 'import':
                    const hasFailed = data.items?.some(item => item.qc_status === 'failed');
                    const hasPending = data.items?.some(item => item.qc_status === 'pending');
                    if (statusFilter === 'failed') statusMatch = hasFailed;
                    else if (statusFilter === 'pending') statusMatch = hasPending && !hasFailed;
                    else if (statusFilter === 'completed') statusMatch = !hasPending && !hasFailed;
                    break;
                case 'adjust':
                    const docStatus = data.dataType === 'transaction' ? 'approved' : data.status;
                    statusMatch = (docStatus === statusFilter);
                    break;
            }
        }
        
        return codeMatch && dateMatch && statusMatch;
    });

    const targetContainerId = (sectionName === 'adjust') ? 'adjustTableContainer' : config.contentId;
    const contentContainer = document.getElementById(targetContainerId);
    if (!contentContainer) return;

    if (filteredData.length === 0) {
        // Nếu không có dữ liệu, hiển thị thông báo chung
        contentContainer.innerHTML = '<p class="text-muted">Không tìm thấy dữ liệu phù hợp.</p>';
        return;
    }

    // Nếu có dữ liệu, vẽ lại bảng và phân trang
    contentContainer.innerHTML = `
        <table class="table table-striped table-compact">
            ${config.tableHeader}
            <tbody id="${config.tableBodyId}"></tbody>
        </table>
        <div id="${config.paginationContainerId}"></div>`;
    // === KẾT THÚC SỬA LỖI CHÍNH ===

    const totalPages = Math.ceil(filteredData.length / itemsPerPage);
    state.page = Math.min(state.page, totalPages) || 1; 

    const startIndex = (state.page - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, filteredData.length);
    const pageData = filteredData.slice(startIndex, endIndex);
    
    const rows = pageData.map(doc => config.createRowFunc(doc));

    const tableBody = document.getElementById(config.tableBodyId);
    if(tableBody) {
        tableBody.innerHTML = '';
        rows.forEach(row => tableBody.appendChild(row));
    }

    renderPaginationControls(sectionName, state.page, totalPages, filteredData.length, startIndex, endIndex);
}

function renderPaginationControls(sectionName, currentPage, totalPages, totalItems, startIndex, endIndex) {
    const config = historyConfig[sectionName];
    if (!config) return;
    
    const container = document.getElementById(config.paginationContainerId);
    if (!container) return;
    
    const renderPageCallback = (newPage) => {
        sectionState[sectionName].page = newPage;
        renderPaginatedHistoryTable(sectionName);
    };

    let paginationHTML = '';
    paginationHTML += `<li class="page-item ${currentPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPage - 1}">Trước</a></li>`;
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `<li class="page-item ${i === currentPage ? 'active' : ''}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
    }
    paginationHTML += `<li class="page-item ${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPage + 1}">Sau</a></li>`;

    container.innerHTML = `
        <div class="d-flex justify-content-between align-items-center mt-3">
            <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${totalItems} kết quả</small>
            <nav><ul class="pagination pagination-sm mb-0">${paginationHTML}</ul></nav>
        </div>
    `;

    container.querySelectorAll('.page-link[data-page]').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const pageNum = parseInt(this.dataset.page);
            if (pageNum >= 1 && !this.parentElement.classList.contains('disabled')) {
                renderPageCallback(pageNum);
            }
        });
    });
}

function createImportRow(doc) {
    const data = doc.id ? doc.data() : doc; // Hỗ trợ cả snapshot và object thường
    const docId = doc.id || data.id;
    const row = document.createElement('tr');
    
    const hasFailed = data.items?.some(item => item.qc_status === 'failed');
    const hasPending = data.items?.some(item => item.qc_status === 'pending');
    if (hasFailed) row.classList.add('table-danger');
    else if (hasPending) row.classList.add('table-warning');

    const date = data.timestamp ? data.timestamp.toDate().toLocaleDateString('vi-VN') : 'N/A';
    let actionButtons = `<button class="btn btn-info btn-sm me-1" onclick="viewImportDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
    if (userRole === 'super_admin') {
        actionButtons += `
            <button class="btn btn-warning btn-sm me-1" onclick="editImportTransaction('${docId}')"><i class="fas fa-edit"></i> Sửa</button>
            <button class="btn btn-danger btn-sm" onclick="deleteImportTransaction('${docId}')"><i class="fas fa-trash"></i> Xóa</button>`;
    }

    row.innerHTML = `
        <td class="text-center">${data.importNumber}</td>
        <td class="text-center">${data.supplier}</td>
        <td class="text-center">${data.items?.length || 0}</td>
        <td class="text-center">${data.performedByName}</td>
        <td class="text-center">${date}</td>
        <td class="text-center">${actionButtons}</td>`;
    return row;
}

function createExportRow(doc) {
    const data = doc.id ? doc.data() : doc;
    const docId = doc.id || data.id;
    const row = document.createElement('tr');
    
    // Logic tương tự cho phiếu xuất (nếu có yêu cầu)
    if(data.dataType === 'pending') row.classList.add('table-warning');
    
    const date = data.timestamp ? data.timestamp.toDate().toLocaleDateString('vi-VN') : 'N/A';
    let actionButtons = `<button class="btn btn-info btn-sm me-1" onclick="viewExportDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
    if (userRole === 'super_admin') {
        actionButtons += `
            <button class="btn btn-warning btn-sm me-1" onclick="editExportTransaction('${docId}')"><i class="fas fa-edit"></i> Sửa</button>
            <button class="btn btn-danger btn-sm" onclick="deleteExportTransaction('${docId}')"><i class="fas fa-trash"></i> Xóa</button>`;
    }

    row.innerHTML = `
        <td class="text-center">${data.exportNumber}</td>
        <td class="text-center">${data.recipient}</td>
        <td class="text-center">${data.items?.length || 0}</td>
        <td class="text-center">${data.performedByName}</td>
        <td class="text-center">${date}</td>
        <td class="text-center">${actionButtons}</td>`;
    return row;
}

function createTransferRow(doc) {
    const data = doc.id ? doc.data() : doc;
    const docId = doc.id || data.id;
    const row = document.createElement('tr');
    const date = data.timestamp ? data.timestamp.toDate().toLocaleDateString('vi-VN') : 'N/A';
    let actionButtons = `<button class="btn btn-info btn-sm me-1" onclick="viewTransferDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
    if (userRole === 'super_admin') {
        actionButtons += `<button class="btn btn-warning btn-sm me-1" onclick="editTransferTransaction('${docId}')"><i class="fas fa-edit"></i> Sửa</button><button class="btn btn-danger btn-sm" onclick="deleteTransferTransaction('${docId}')"><i class="fas fa-trash"></i> Xóa</button>`;
    }
    row.innerHTML = `<td class="text-center">${data.itemCode}</td><td class="text-center">${data.quantity}</td><td class="text-center">${data.fromLocation}</td><td class="text-center">${data.toLocation}</td><td class="text-center">${data.performedByName}</td><td class="text-center">${date}</td><td class="text-center">${actionButtons}</td>`;
    return row;
}

// File: js/warehouse.js

function createAdjustRow(doc) {
    const data = doc;
    const docId = data.id;
    const row = document.createElement('tr');
    
    let statusBadge = '';
    let handlerDisplay = '';
    let displayReason = data.reason || 'N/A';
    let actionButtons = `<button class="btn btn-info btn-sm" onclick="viewAdjustRequestDetails('${docId}')"><i class="fas fa-eye"></i> Xem</button>`;
    
    if (data.dataType === 'request') {
        if (data.status === 'pending') {
            statusBadge = `<span class="badge bg-warning text-dark">Chờ duyệt</span>`;
            handlerDisplay = `Y/c bởi: <strong>${data.requestedByName}</strong>`;
            if (userRole === 'super_admin') {
                actionButtons += `
                    <button class="btn btn-success btn-sm ms-1" onclick="approveAdjustRequest('${docId}')"><i class="fas fa-check"></i> Duyệt</button>
                    <button class="btn btn-danger btn-sm ms-1" onclick="rejectAdjustRequest('${docId}')"><i class="fas fa-times"></i> Từ chối</button>
                `;
            }
        } else { // status === 'rejected'
            statusBadge = `<span class="badge bg-danger">Đã từ chối</span>`;
            handlerDisplay = `Từ chối bởi: <strong>${data.rejectedByName}</strong>`;
        }
    } else { // dataType === 'transaction'
        statusBadge = `<span class="badge bg-success">Đã duyệt</span>`;
        if (data.requestedByName) { // Giao dịch được tạo từ một yêu cầu
            handlerDisplay = `
                <div>Y/c bởi: <strong>${data.requestedByName}</strong></div>
                <div class="mt-1">Duyệt bởi: <strong>${data.performedByName}</strong></div>
            `;
        } else { // Giao dịch được tạo trực tiếp
            handlerDisplay = `Thực hiện: <strong>${data.performedByName}</strong>`;
        }
    }

    const date = data.timestamp?.toDate().toLocaleDateString('vi-VN') || 'N/A';

    row.innerHTML = `
        <td>${displayReason}</td>
        <td class="text-center">${data.items?.length || 0}</td>
        <td class="text-center">${statusBadge}</td>
        <td>${handlerDisplay}</td>
        <td class="text-center">${date}</td>
        <td class="text-center">${actionButtons}</td>`;
    return row;
}

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
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Chi tiết chỉnh số tồn kho</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <!-- THÔNG TIN CHUNG -->
                    <div class="row mb-3 theme-aware-info-box">
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
                        <p class="ms-2 mt-1 mb-0 fst-italic theme-aware-inset-box p-2 rounded">${data.reason}</p>
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


window.viewExportRequestDetails = async function (requestId) {
    try {
        const requestDoc = await getDoc(doc(db, 'export_requests', requestId));
        if (!requestDoc.exists()) {
            return showToast('Không tìm thấy yêu cầu xuất kho.', 'danger');
        }

        const req = requestDoc.data();
        const date = req.timestamp.toDate().toLocaleString('vi-VN');

        // Tạo bảng HTML cho các mã hàng
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
            <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
                                    <tr class="text-center">
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

window.approveExportRequest = async function (requestId) {
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

        // 2. Trừ tồn kho cho từng mã hàng
        for (const item of reqData.items) {
            const invRef = doc(db, 'inventory', item.inventoryId);
            // Kiểm tra lại tồn kho trước khi trừ để đảm bảo an toàn
            const invSnap = await getDoc(invRef);
            if (!invSnap.exists() || invSnap.data().quantity < item.requestedQuantity) {
                throw new Error(`Không đủ tồn kho cho mã hàng ${item.code}.`);
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

    } catch (e) {
        console.error("Lỗi khi duyệt yêu cầu xuất kho:", e);
        showToast(e.message || 'Lỗi khi duyệt yêu cầu.', 'danger');
    }
}

window.rejectExportRequest = async function (requestId) {
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
        <div class="modal-dialog modal-xl">
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
                    <div class="row mb-3 theme-aware-info-box">
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
            deletedSupplier: data.supplier,
            deletedItems: data.items,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã xóa phiếu nhập thành công!', 'success');

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
            deletedRecipient: data.recipient,
            deletedItems: data.items,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Đã xóa phiếu xuất thành công!', 'success');

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

// REPLACE THIS FUNCTION in warehouse.js
function createEditTransferModal(transactionId, data) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editTransferModal';

    // --- NEW: Logic to parse the destination location and create selector options ---
    const locationRegex = /^([A-Z])(\d+)-(\d+)$/;
    const match = data.toLocation.match(locationRegex);
    const currentAisle = match ? match[1] : '';
    const currentBay = match ? parseInt(match[2], 10) : '';
    const currentLevel = match ? parseInt(match[3], 10) : '';

    const aisleOptions = layoutConfig.aisles.map(a => `<option value="${a}" ${currentAisle === a ? 'selected' : ''}>Dãy ${a}</option>`).join('');
    let bayOptions = '';
    for (let i = 1; i <= layoutConfig.maxBay; i++) {
        bayOptions += `<option value="${i}" ${currentBay === i ? 'selected' : ''}>Kệ ${i}</option>`;
    }
    let levelOptions = '';
    for (let i = 1; i <= layoutConfig.maxLevel; i++) {
        levelOptions += `<option value="${i}" ${currentLevel === i ? 'selected' : ''}>Tầng ${i}</option>`;
    }
    // --- END NEW LOGIC ---

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
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
                        
                        <div class="row mb-3 align-items-end">
                            <div class="col-md-6">
                                <label class="form-label">Từ vị trí (Không đổi)</label>
                                <input type="text" class="form-control" id="editFromLocation" value="${data.fromLocation}" readonly>
                            </div>                           
                            <div class="col-md-6">
                                <label class="form-label">Đến vị trí mới</label>
                                <div class="row g-2">
                                    <div class="col">
                                        <select class="form-select" id="editToAisle">${aisleOptions}</select>
                                    </div>
                                    <div class="col">
                                        <select class="form-select" id="editToBay">${bayOptions}</select>
                                    </div>
                                    <div class="col">
                                        <select class="form-select" id="editToLevel">${levelOptions}</select>
                                    </div>
                                </div>
                            </div>                                                  
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <label class="form-label">Số lượng chuyển</label>
                                <input type="number" class="form-control" id="editTransferQuantity" value="${data.quantity}" min="1" required data-original="${data.quantity}">
                            </div>
                            <div class="col-md-6">
                                <label class="form-label">Ghi chú</label>
                                <input type="text" class="form-control" id="editTransferNote" value="${data.note || ''}">
                            </div>
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

// REPLACE THIS FUNCTION in warehouse.js
window.saveEditTransfer = async function () {
    const transactionId = document.getElementById('editTransferTransactionId').value;
    const itemCode = document.getElementById('editTransferItemCode').value;
    const fromLocation = document.getElementById('editFromLocation').value;

    // --- UPDATED: Read destination from new selectors ---
    const newAisle = document.getElementById('editToAisle').value;
    const newBay = document.getElementById('editToBay').value;
    const newLevel = document.getElementById('editToLevel').value;
    const toLocation = `${newAisle}${newBay}-${newLevel.toString().padStart(2, '0')}`;
    // --- END UPDATE ---

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

        // Update transaction with the newly constructed `toLocation`
        batch.update(doc(db, 'transactions', transactionId), {
            fromLocation: fromLocation, // fromLocation is readonly, but we include it for clarity
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
            // Create new inventory record if destination doesn't exist
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
                note: { from: originalData.note || '', to: note }
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

// Thay thế hàm này trong warehouse.js
// Thay thế toàn bộ hàm cũ bằng phiên bản mới này
export function showConfirmation(title, message, confirmText = 'Xác nhận', cancelText = 'Hủy', type = 'warning') {
    return new Promise((resolve) => {
        // Hàm tạo modal vẫn giữ nguyên
        const modal = createConfirmationModal(title, message, confirmText, cancelText, type);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);

        const confirmBtn = modal.querySelector('#confirmBtn');

        // === BẮT ĐẦU SỬA LỖI LOGIC ===

        // 1. Tách riêng hàm xử lý hủy bỏ
        const handleCancel = () => {
            resolve(false);
        };

        // 2. Tách riêng hàm xử lý xác nhận
        const handleConfirm = () => {
            // Quan trọng: Gỡ bỏ trình lắng nghe sự kiện hủy trước khi làm bất cứ điều gì khác
            modal.removeEventListener('hidden.bs.modal', handleCancel);
            resolve(true);
        };
        
        // 3. Gán sự kiện
        confirmBtn.addEventListener('click', handleConfirm);

        // Sự kiện 'hidden' giờ chỉ dành cho việc người dùng nhấn nút 'X' hoặc click ra ngoài
        modal.addEventListener('hidden.bs.modal', handleCancel, { once: true });
        
        // Sự kiện dọn dẹp cuối cùng, luôn chạy sau khi modal đã đóng
        modal.addEventListener('hidden.bs.modal', () => {
            bsModal.dispose();
            modal.remove();
        });

        // === KẾT THÚC SỬA LỖI LOGIC ===

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
        // THAY ĐỔI: Thêm cột 'Vị trí'
        ['Mã hàng', 'Vị trí', 'Số lượng xuất'],
        ['SP-EXIST-01', 'A1-01', '5'],
        ['SP-EXIST-02', 'B2-04', '10']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }];
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

            // THAY ĐỔI: Đọc 3 cột và thêm 'location'
            const items = data.slice(1).filter(row => row.length >= 3 && row[0]).map(row => ({
                code: row[0]?.toString() || '',
                location: row[1]?.toString() || '', // Thêm vị trí
                quantity: parseInt(row[2]) || 0
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
                                <tr class="text-center">
                                    <th>Mã hàng</th>
                                    <th>Tên mô tả</th>
                                    <th>Vị trí</th>
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
            // THAY ĐỔI: Tìm kiếm theo cả code VÀ location để xác định duy nhất
            const inventoryQuery = query(
                collection(db, 'inventory'),
                where('code', '==', item.code),
                where('location', '==', item.location),
                limit(1)
            );
            const snapshot = await getDocs(inventoryQuery);

            if (snapshot.empty) {
                row.className = 'table-danger';
                row.innerHTML = `
                    <td class="text-center">${item.code}</td>
                    <td class="text-center">Không tìm thấy</td>
                    <td class="text-center">${item.location}</td>
                    <td class="text-center">${item.quantity}</td>
                    <td class="text-center">-</td>
                    <td class="text-center">-</td>
                    <td class="text-center"><span class="badge bg-danger">Không tồn tại</span></td>
                `;
                allValid = false;
            } else {
                const doc = snapshot.docs[0];
                const data = doc.data();

                if (item.quantity > data.quantity) {
                    row.className = 'table-warning';
                    allValid = false;
                    row.innerHTML = `
                        <td class="text-center">${item.code}</td>
                        <td class="text-center">${data.name}</td>
                        <td class="text-center">${item.location}</td>
                        <td class="text-center">${item.quantity}</td>
                        <td class="text-center">${data.quantity}</td>
                        <td class="text-center">${data.unit}</td>
                        <td class="text-center"><span class="badge bg-warning text-dark">Vượt tồn kho</span></td>
                    `;
                } else {
                    // Các trường hợp khác vẫn giữ nguyên...
                    row.className = 'table-success';
                    row.innerHTML = `
                        <td class="text-center">${item.code}</td>
                        <td class="text-center">${data.name}</td>
                         <td class="text-center">${item.location}</td>
                        <td class="text-center">${item.quantity}</td>
                        <td class="text-center">${data.quantity}</td>
                        <td class="text-center">${data.unit}</td>
                        <td class="text-center"><span class="badge bg-success">Hợp lệ</span></td>
                    `;
                    validItems.push({
                        inventoryId: doc.id,
                        code: item.code,
                        name: data.name,
                        quantity: item.quantity,
                        unit: data.unit,
                        availableQuantity: data.quantity,
                        location: item.location // Lưu lại vị trí để ghi log
                    });
                }
            }
        } catch (error) {
            console.error('Error checking item:', error);
            row.className = 'table-danger';
            row.innerHTML = `
                <td class="text-center">${item.code}</td>
                <td class="text-center">Lỗi kiểm tra</td>
                 <td class="text-center">${item.location}</td>
                <td class="text-center">${item.quantity}</td>
                <td class="text-center">-</td>
                <td class="text-center">-</td>
                <td class="text-center"><span class="badge bg-danger">Lỗi</span></td>
            `;
            allValid = false;
        }

        tbody.appendChild(row);
    }

    saveBtn.disabled = !allValid || validItems.length === 0;
    window.validExportItems = validItems; // Store for saving
}

window.saveExcelExport = async function () {
    const exportNumber = document.getElementById('excelExportNumber').value.trim();
    const recipient = document.getElementById('excelRecipient').value.trim();

    if (!exportNumber || !recipient) {
        showToast('Vui lòng điền đầy đủ thông tin', 'warning');
        return;
    }

    if (!window.validExportItems || window.validExportItems.length === 0) {
        showToast('Không có mã hàng hợp lệ để xuất', 'warning');
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

window.saveExcelTransfers = async function () {
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

function downloadAdjustTemplate() {
    const data = [
        // SỬA ĐỔI: Bỏ cột "Lý do điều chỉnh"
        ['Mã hàng', 'Vị trí', 'Số lượng MỚI'],
        ['SP-EXIST-01', 'A1-01', '99']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 15 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Chinh_So');
    XLSX.writeFile(wb, 'mau-chinh-so.xlsx');
}

// Thay thế hàm này trong warehouse.js
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

            // SỬA ĐỔI: Chỉ đọc 3 cột, bỏ qua cột lý do dòng
            const adjustments = data.slice(1).filter(row => row.length >= 3 && row[0] && row[1] && row[2] !== undefined).map(row => ({
                code: row[0]?.toString().trim() || '',
                location: row[1]?.toString().trim() || '',
                newQuantity: parseInt(row[2]),
            }));

            if (adjustments.length > 0) {
                showAdjustExcelPreviewModal(adjustments);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ hoặc thiếu cột.', 'warning');
            }

        } catch (error) {
            console.error('Lỗi đọc file Excel:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = '';
}

// Thay thế hàm này trong warehouse.js
function showAdjustExcelPreviewModal(adjustments) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'adjustExcelPreviewModal';

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-danger text-white">
                    <h5 class="modal-title">Xem trước & Xác nhận Chỉnh số từ Excel</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-danger">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Cảnh báo:</strong> Toàn bộ các thay đổi dưới đây sẽ được gộp vào MỘT phiếu chỉnh số duy nhất và thực hiện ngay lập tức.
                    </div>

                    <div class="mb-3">
                        <label for="excelGeneralReason" class="form-label"><strong>Lý do chung cho phiếu chỉnh số <span class="text-danger">*</span></strong></label>
                        <input type="text" class="form-control" id="excelGeneralReason" placeholder="VD: Kiểm kê kho định kỳ cuối năm..." required>
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelAdjustPreviewTable">
                            <thead class="table-danger">
                                <tr class="text-center">
                                    <th>Mã hàng</th>
                                    <th>Vị trí</th>
                                    <th>SL Cũ</th>
                                    <th>SL Mới</th>
                                    <th>Chênh lệch</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-danger" onclick="saveExcelAdjustments()" id="saveExcelAdjustmentsBtn" disabled>
                        Thực hiện chỉnh số
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    validateAndDisplayAdjustItems(adjustments);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

// Thay thế hàm này trong warehouse.js
async function validateAndDisplayAdjustItems(adjustments) {
    const tbody = document.querySelector('#excelAdjustPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelAdjustmentsBtn');
    let allValid = true;
    const validatedItems = [];

    tbody.innerHTML = '';

    for (const item of adjustments) {
        const row = document.createElement('tr');
        let statusBadge = '';
        let itemIsValid = true;

        if (!item.code || !item.location || isNaN(item.newQuantity)) {
            statusBadge = `<span class="badge bg-danger">Lỗi - Thiếu thông tin</span>`;
            itemIsValid = false;
            row.classList.add('table-danger');
            item.newQuantity = isNaN(item.newQuantity) ? 0 : item.newQuantity;
        }

        if (itemIsValid) {
            try {
                const inventoryQuery = query(collection(db, 'inventory'), where('code', '==', item.code), where('location', '==', item.location), limit(1));
                const snapshot = await getDocs(inventoryQuery);

                if (snapshot.empty) {
                    statusBadge = `<span class="badge bg-danger">Không tìm thấy</span>`;
                    itemIsValid = false;
                    row.classList.add('table-danger');
                    row.innerHTML = `<td>${item.code}</td><td>${item.location}</td><td>-</td><td>${item.newQuantity}</td><td>-</td><td>${statusBadge}</td>`;
                } else {
                    const doc = snapshot.docs[0];
                    const data = doc.data();
                    const difference = item.newQuantity - data.quantity;
                    const diffClass = difference > 0 ? 'text-success' : difference < 0 ? 'text-danger' : 'text-muted';

                    if (item.newQuantity < 0) {
                        statusBadge = `<span class="badge bg-warning text-dark">SL âm</span>`;
                        itemIsValid = false;
                        row.classList.add('table-warning');
                    } else if (difference === 0) {
                        statusBadge = `<span class="badge bg-info">Không đổi</span>`;
                    } else {
                        statusBadge = `<span class="badge bg-success">Hợp lệ</span>`;
                    }

                    row.innerHTML = `
                        <td class="text-center" style="width: 16%">${item.code}</td>
                        <td class="text-center" style="width: 16%">${item.location}</td>
                        <td class="text-center" style="width: 16%">${data.quantity}</td>
                        <td class="text-center" style="width: 16%">${item.newQuantity}</td>
                        <td class="${diffClass}" class="text-center" style="width: 16%">${difference >= 0 ? '+' : ''}${difference}</td>
                        <td class="text-center" style="width: 16%">${statusBadge}</td>`;

                    if (itemIsValid) {
                        validatedItems.push({
                            inventoryId: doc.id,
                            itemCode: item.code,
                            itemName: data.name,
                            location: item.location,
                            previousQuantity: data.quantity,
                            newQuantity: item.newQuantity,
                            adjustment: difference
                        });
                    }
                }
            } catch (error) {
                statusBadge = `<span class="badge bg-danger">Lỗi kiểm tra</span>`;
                itemIsValid = false;
                row.classList.add('table-danger');
                row.innerHTML = `<td>${item.code}</td><td>${item.location}</td><td>-</td><td>${item.newQuantity}</td><td>-</td><td>${statusBadge}</td>`;
            }
        } else {
            row.innerHTML = `<td>${item.code}</td><td>${item.location}</td><td>-</td><td>${item.newQuantity}</td><td>-</td><td>${statusBadge}</td>`;
        }

        tbody.appendChild(row);
        if (!itemIsValid) {
            allValid = false;
        }
    }

    saveBtn.disabled = !allValid || validatedItems.length === 0;
    window.validatedAdjustments = validatedItems;
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

// Thay thế hàm này trong warehouse.js
window.saveExcelAdjustments = async function () {
    if (userRole !== 'super_admin') {
        return showToast('Chỉ Super Admin mới có quyền thực hiện thao tác này', 'danger');
    }

    // Lấy lý do chung từ modal xem trước
    const generalReason = document.getElementById('excelGeneralReason')?.value.trim();
    if (!generalReason) {
        return showToast('Vui lòng nhập lý do chung cho phiếu chỉnh số.', 'warning');
    }

    // Lấy danh sách đã được kiểm tra từ biến toàn cục
    const adjustmentsToProcess = window.validatedAdjustments;
    if (!adjustmentsToProcess || adjustmentsToProcess.length === 0) {
        return showToast('Không có điều chỉnh hợp lệ nào để thực hiện.', 'warning');
    }

    const confirmed = await showConfirmation(
        'Xác nhận chỉnh số hàng loạt',
        `Bạn có chắc muốn thực hiện ${adjustmentsToProcess.length} thay đổi trong MỘT phiếu chỉnh số?`,
        'Thực hiện chỉnh số', 'Hủy', 'danger'
    );
    if (!confirmed) return;

    try {
        const batch = writeBatch(db);

        // 1. Tạo MỘT bản ghi giao dịch duy nhất chứa tất cả các thay đổi
        const transactionRef = doc(collection(db, 'transactions'));
        batch.set(transactionRef, {
            type: 'adjust',
            subtype: 'direct_excel', // Đánh dấu nguồn
            reason: generalReason, // Lý do chung
            items: adjustmentsToProcess, // Mảng chứa tất cả các mã hàng
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            date: serverTimestamp(),
            timestamp: serverTimestamp()
        });

        // 2. Cập nhật tồn kho cho từng mã hàng trong batch
        for (const adjustment of adjustmentsToProcess) {
            if (adjustment.adjustment !== 0) { // Chỉ cập nhật nếu có chênh lệch
                const inventoryRef = doc(db, 'inventory', adjustment.inventoryId);
                batch.update(inventoryRef, { quantity: adjustment.newQuantity });
            }
        }

        await batch.commit();

        showToast('Chỉnh số từ Excel thành công!', 'success');
        const modal = document.getElementById('adjustExcelPreviewModal');
        if (modal) {
            bootstrap.Modal.getInstance(modal).hide();
        }
        loadAdjustData();

    } catch (error) {
        console.error('Lỗi lưu điều chỉnh từ Excel:', error);
        showToast('Lỗi lưu điều chỉnh từ Excel', 'danger');
    }
};

// Thay thế hàm này trong warehouse.js
function downloadRequestAdjustTemplate() {
    const data = [
        // SỬA ĐỔI: Bỏ cột "Lý do yêu cầu"
        ['Mã hàng', 'Vị trí', 'Số lượng ĐỀ XUẤT'],
        ['SP-EXIST-01', 'A1-01', '101']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 15 }, { wch: 15 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Yeu_Cau_Chinh_So');
    XLSX.writeFile(wb, 'mau-yeu-cau-chinh-so.xlsx');
}

// Thay thế hàm này trong warehouse.js
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

            // SỬA ĐỔI: Chỉ đọc 3 cột và đổi tên `newQuantity` thành `requestedQuantity`
            const requests = data.slice(1).filter(row => row.length >= 3 && row[0] && row[1] && row[2] !== undefined).map(row => ({
                code: row[0]?.toString().trim() || '',
                location: row[1]?.toString().trim() || '',
                requestedQuantity: parseInt(row[2]),
            }));

            if (requests.length > 0) {
                showRequestAdjustExcelImportModal(requests);
            } else {
                showToast('File Excel không có dữ liệu hợp lệ hoặc thiếu cột.', 'warning');
            }

        } catch (error) {
            console.error('Lỗi đọc file Excel:', error);
            showToast('Lỗi đọc file Excel', 'danger');
        }
    };

    reader.readAsBinaryString(file);
    event.target.value = '';
}

// Thêm hàm MỚI này vào warehouse.js
function showRequestAdjustExcelImportModal(requests) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'requestAdjustExcelImportModal';

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title">Xem trước & Xác nhận Yêu cầu Chỉnh số từ Excel</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle"></i>
                        <strong>Thông tin:</strong> Toàn bộ các thay đổi dưới đây sẽ được gộp vào MỘT phiếu yêu cầu và gửi đến Super Admin để phê duyệt.
                    </div>

                    <div class="mb-3">
                        <label for="excelRequestGeneralReason" class="form-label"><strong>Lý do chung cho phiếu yêu cầu <span class="text-danger">*</span></strong></label>
                        <input type="text" class="form-control" id="excelRequestGeneralReason" placeholder="VD: Kiểm kê kho định kỳ..." required>
                    </div>
                    
                    <div class="table-responsive">
                        <table class="table table-bordered" id="excelRequestAdjustPreviewTable">
                            <thead class="table-primary">
                                <tr>
                                    <th>Mã hàng</th>
                                    <th>Vị trí</th>
                                    <th>SL Cũ</th>
                                    <th>SL Đề xuất</th>
                                    <th>Chênh lệch</th>
                                    <th>Trạng thái</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Hủy</button>
                    <button type="button" class="btn btn-primary" onclick="saveExcelRequestAdjustments()" id="saveExcelRequestAdjustmentsBtn" disabled>
                        Gửi yêu cầu
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    loadRequestAdjustItemDetails(requests);

    modal.addEventListener('hidden.bs.modal', () => {
        modal.remove();
    });
}

// Thêm hàm MỚI này vào warehouse.js
async function loadRequestAdjustItemDetails(requests) {
    const tbody = document.querySelector('#excelRequestAdjustPreviewTable tbody');
    const saveBtn = document.getElementById('saveExcelRequestAdjustmentsBtn');
    let allValid = true;
    const validRequests = [];

    tbody.innerHTML = '';

    for (const request of requests) {
        const row = document.createElement('tr');
        let statusBadge = '';
        let itemIsValid = true;

        if (!request.code || !request.location || isNaN(request.requestedQuantity)) {
            statusBadge = `<span class="badge bg-danger">Lỗi - Thiếu thông tin</span>`;
            itemIsValid = false;
            row.classList.add('table-danger');
            request.requestedQuantity = isNaN(request.requestedQuantity) ? 0 : request.requestedQuantity;
            row.innerHTML = `<td>${request.code}</td><td>${request.location}</td><td>-</td><td>${request.requestedQuantity}</td><td>-</td><td>${statusBadge}</td>`;
        } else {
            try {
                const inventoryQuery = query(collection(db, 'inventory'), where('code', '==', request.code), where('location', '==', request.location), limit(1));
                const snapshot = await getDocs(inventoryQuery);

                if (snapshot.empty) {
                    statusBadge = `<span class="badge bg-danger">Không tìm thấy</span>`;
                    itemIsValid = false;
                    row.classList.add('table-danger');
                    row.innerHTML = `<td>${request.code}</td><td>${request.location}</td><td>-</td><td>${request.requestedQuantity}</td><td>-</td><td>${statusBadge}</td>`;
                } else {
                    const doc = snapshot.docs[0];
                    const data = doc.data();
                    const difference = request.requestedQuantity - data.quantity;
                    const diffClass = difference > 0 ? 'text-success' : difference < 0 ? 'text-danger' : 'text-muted';

                    if (request.requestedQuantity < 0) {
                        statusBadge = `<span class="badge bg-warning text-dark">SL âm</span>`;
                        itemIsValid = false;
                        row.classList.add('table-warning');
                    } else if (difference === 0) {
                        statusBadge = `<span class="badge bg-info">Không đổi</span>`;
                    } else {
                        statusBadge = `<span class="badge bg-success">Hợp lệ</span>`;
                    }

                    row.innerHTML = `
                        <td>${request.code}</td><td>${request.location}</td>
                        <td>${data.quantity}</td><td>${request.requestedQuantity}</td>
                        <td class="${diffClass}">${difference >= 0 ? '+' : ''}${difference}</td>
                        <td>${statusBadge}</td>`;

                    if (itemIsValid) {
                        validRequests.push({
                            inventoryId: doc.id,
                            itemCode: request.code,
                            itemName: data.name,
                            location: request.location,
                            currentQuantity: data.quantity,
                            requestedQuantity: request.requestedQuantity,
                            adjustment: difference,
                        });
                    }
                }
            } catch (error) {
                statusBadge = `<span class="badge bg-danger">Lỗi kiểm tra</span>`;
                itemIsValid = false;
                row.classList.add('table-danger');
                row.innerHTML = `<td>${request.code}</td><td>${request.location}</td><td>-</td><td>${request.requestedQuantity}</td><td>-</td><td>${statusBadge}</td>`;
            }
        }

        tbody.appendChild(row);
        if (!itemIsValid) {
            allValid = false;
        }
    }

    saveBtn.disabled = !allValid || validRequests.length === 0;
    window.validRequestAdjustments = validRequests;
}

// Thêm hàm MỚI này vào warehouse.js
window.saveExcelRequestAdjustments = async function () {
    const generalReason = document.getElementById('excelRequestGeneralReason')?.value.trim();
    if (!generalReason) {
        return showToast('Vui lòng nhập lý do chung cho phiếu yêu cầu.', 'warning');
    }

    const requestsToSave = window.validRequestAdjustments;
    if (!requestsToSave || requestsToSave.length === 0) {
        return showToast('Không có yêu cầu hợp lệ nào để gửi đi.', 'warning');
    }

    try {
        await addDoc(collection(db, 'adjustment_requests'), {
            reason: generalReason,
            items: requestsToSave, // Mảng chứa tất cả các yêu cầu
            status: 'pending',
            requestedBy: currentUser.uid,
            requestedByName: currentUser.name,
            requestDate: serverTimestamp(),
            timestamp: serverTimestamp(),
            source: 'excel_request' // Đánh dấu nguồn
        });

        showToast('Đã gửi yêu cầu chỉnh số từ Excel thành công!', 'success');
        const modal = document.getElementById('requestAdjustExcelImportModal');
        if (modal) {
            bootstrap.Modal.getInstance(modal).hide();
        }
        loadAdjustData();

    } catch (error) {
        console.error('Lỗi lưu yêu cầu chỉnh số từ Excel:', error);
        showToast('Lỗi khi gửi yêu cầu chỉnh số từ Excel.', 'danger');
    }
};


function initializeExcelFunctions() {
    // Sử dụng một trình lắng nghe ủy quyền duy nhất để có hiệu suất tốt hơn
    const contentArea = document.querySelector('main.col-md-9');
    if (!contentArea) return;

    contentArea.addEventListener('click', function (event) {
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

// warehouse.js

export function loadPrintBarcodeSection() {
    // THÊM CỜ KIỂM TRA: Nếu đã gán sự kiện rồi thì chỉ cập nhật và thoát
    if (printBarcodeListenersInitialized) {
        updateBarcodeCanvasSize(); // Vẫn cập nhật kích thước canvas mỗi khi vào lại
        return;
    }

    // Gán tất cả các sự kiện chỉ một lần duy nhất
    document.getElementById('barcodeItemSearch').addEventListener('input', debounce(searchItemsForBarcode, 300));
    document.getElementById('paperSizeSelector').addEventListener('change', updateBarcodeCanvasSize);
    document.getElementById('printBarcodeBtn').addEventListener('click', () => window.print());
    document.getElementById('saveTemplateBtn').addEventListener('click', saveCurrentTemplate);
    document.getElementById('templateLoader').addEventListener('change', applySelectedTemplate);
    document.getElementById('deleteTemplateBtn').addEventListener('click', deleteSelectedTemplate);
    document.getElementById('customWidthInput')?.addEventListener('input', debounce(updateBarcodeCanvasSize, 300));
    document.getElementById('customHeightInput')?.addEventListener('input', debounce(updateBarcodeCanvasSize, 300));
    document.getElementById('downloadQuickPrintTemplateLink').addEventListener('click', (e) => {
        e.preventDefault();
        downloadQuickPrintTemplate();
    });
    document.getElementById('quickPrintExcelBtn').addEventListener('click', () => {
        document.getElementById('quickPrintExcelInput').click();
    });
    document.getElementById('quickPrintExcelInput').addEventListener('change', handleQuickPrintExcel);

    // ĐÁNH DẤU LÀ ĐÃ KHỞI TẠO để không chạy lại khối lệnh trên
    printBarcodeListenersInitialized = true;

    // Các tác vụ này vẫn cần chạy mỗi khi vào mục
    loadBarcodeTemplates();
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

function applySelectedTemplate() {
    const templateName = document.getElementById('templateLoader').value;
    if (!templateName) return;

    const template = savedTemplates.find(t => t.name === templateName);
    if (template) {
        // Áp dụng kích thước giấy (phần này đã đúng)
        document.getElementById('paperSizeSelector').value = template.paperSize;
        if (template.paperSize === 'custom') {
            document.getElementById('customWidthInput').value = template.customWidth || 4;
            document.getElementById('customHeightInput').value = template.customHeight || 3;
        }
        updateBarcodeCanvasSize();

        // --- LOGIC MỚI: Định vị lại các phần tử hiện có ---
        if (template.layout) {
            document.querySelectorAll('.barcode-element').forEach(el => {
                const key = el.dataset.key;
                const savedPosition = template.layout[key];
                if (savedPosition) {
                    el.style.top = `${savedPosition.top}px`;
                    el.style.left = `${savedPosition.left}px`;
                }
            });
        }

        showToast(`Đã áp dụng mẫu "${templateName}".`, "info");
    }
}

// warehouse.js

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

    // --- LOGIC MỚI ĐỂ LƯU TEMPLATE CHUẨN HÓA ---
    const layoutToSave = {};

    // Định nghĩa nội dung gốc (với placeholder) cho từng phần tử
    const originalTexts = {
        itemInfo: '{code} - {name}',
        stockInfo: 'SL: {quantity} - Vị trí: {location}',
    };

    document.querySelectorAll('.barcode-element').forEach(el => {
        const key = el.dataset.key;

        if (key === 'barcode') {
            layoutToSave[key] = {
                type: 'barcode',
                top: el.offsetTop,
                left: el.offsetLeft,
                width: 2, // Lấy giá trị mặc định, có thể nâng cấp sau
                height: 40 // Lấy giá trị mặc định, có thể nâng cấp sau
            };
        } else {
            layoutToSave[key] = {
                type: 'text',
                text: originalTexts[key] || '', // Lưu lại văn bản gốc với placeholder
                top: el.offsetTop,
                left: el.offsetLeft
            };
        }
    });

    const newTemplate = {
        name: templateName,
        paperSize: document.getElementById('paperSizeSelector').value,
        layout: layoutToSave, // Lưu layout đã được chuẩn hóa
        userId: currentUser.uid,
        createdAt: serverTimestamp()
    };

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

// warehouse.js

async function searchItemsForBarcode(event) {
    const searchTerm = event.target.value.trim();
    const resultsContainer = document.getElementById('barcodeSearchResults');
    resultsContainer.innerHTML = '';

    if (searchTerm.length < 2) {
        return;
    }

    try {
        const upperCaseTerm = searchTerm.toUpperCase();

        const codeQuery = query(
            collection(db, 'inventory'),
            orderBy('code'),
            where('code', '>=', upperCaseTerm),
            where('code', '<=', upperCaseTerm + '\uf8ff'),
            limit(10)
        );

        const nameQuery = query(
            collection(db, 'inventory'),
            orderBy('name'),
            where('name', '>=', searchTerm),
            where('name', '<=', searchTerm + '\uf8ff'),
            limit(10)
        );

        // SỬA LỖI TẠI ĐÂY: getDocs(nameQuery) thay vì getDocs(nameSnapshot)
        const [codeSnapshot, nameSnapshot] = await Promise.all([
            getDocs(codeQuery),
            getDocs(nameQuery)
        ]);

        const resultsMap = new Map();

        const processSnapshot = (snapshot) => {
            snapshot.forEach(doc => {
                if (!resultsMap.has(doc.id)) {
                    resultsMap.set(doc.id, { id: doc.id, ...doc.data() });
                }
            });
        };

        processSnapshot(codeSnapshot);
        processSnapshot(nameSnapshot);

        const activeResults = Array.from(resultsMap.values())
            .filter(item => item.status !== 'archived');

        if (activeResults.length === 0) {
            resultsContainer.innerHTML = '<div class="list-group-item text-muted">Không tìm thấy mã hàng phù hợp.</div>';
            return;
        }

        const resultsHtml = activeResults.map(item => {
            const itemJsonString = JSON.stringify(item).replace(/'/g, "\\'");
            return `<button type="button" class="list-group-item list-group-item-action" 
                    onclick='selectItemForBarcode(${itemJsonString})'>
                    <strong>${item.code}</strong> - ${item.name} (Tồn: ${item.quantity} | Vị trí: ${item.location})
                </button>`;
        }).join('');

        resultsContainer.innerHTML = `<div class="list-group mt-2">${resultsHtml}</div>`;

    } catch (error) {
        console.error("Lỗi tìm kiếm mã hàng cho barcode:", error);
        resultsContainer.innerHTML = '<div class="list-group-item text-danger">Lỗi khi tìm kiếm. Vui lòng kiểm tra lại cấu hình Firestore.</div>';
    }
}



window.selectItemForBarcode = function (item) {
    currentBarcodeItem = item;

    // Dọn dẹp kết quả tìm kiếm sau khi đã chọn
    const resultsContainer = document.getElementById('barcodeSearchResults');
    if (resultsContainer) {
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

// warehouse.js

function renderBarcodeLabel() {
    const canvas = document.getElementById('barcode-canvas');
    canvas.innerHTML = ''; // Xóa tem cũ trước khi vẽ tem mới

    if (!currentBarcodeItem) return;

    // --- LOGIC MỚI ĐỂ CHỌN LAYOUT ---
    const selectedTemplateName = document.getElementById('templateLoader').value;
    let layoutToUse = null;

    // 1. Kiểm tra xem có template nào được chọn không
    if (selectedTemplateName) {
        const template = savedTemplates.find(t => t.name === selectedTemplateName);
        if (template && template.layout) {
            layoutToUse = template.layout;
        }
    }

    // 2. Nếu không có template nào được chọn, sử dụng layout mặc định
    if (!layoutToUse) {
        layoutToUse = {
            itemInfo: { text: '{code} - {name}', top: 5, left: 5, type: 'text' },
            stockInfo: { text: 'SL: {quantity} - Vị trí: {location}', top: 30, left: 5, type: 'text' },
            barcode: { type: 'barcode', top: 55, left: 5, width: 2, height: 40 }
        };
    }

    // --- LOGIC VẼ TEM DỰA TRÊN LAYOUT ĐÃ CHỌN ---
    for (const key in layoutToUse) {
        const elementData = layoutToUse[key];
        const div = document.createElement('div');
        div.className = 'barcode-element';
        div.dataset.key = key; // Rất quan trọng để lưu lại layout

        if (elementData.type === 'barcode') {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.id = 'barcode-svg';
            div.appendChild(svg);
            JsBarcode(svg, currentBarcodeItem.code, { // Luôn dùng mã của mã hàng hiện tại
                width: elementData.width,
                height: elementData.height,
                displayValue: true
            });
        } else { // Mặc định là 'text'
            // Thay thế các placeholder bằng thông tin mã hàng thực tế
            let text = elementData.text || '';
            text = text.replace(/{code}/g, currentBarcodeItem.code);
            text = text.replace(/{name}/g, currentBarcodeItem.name);
            text = text.replace(/{quantity}/g, currentBarcodeItem.quantity);
            text = text.replace(/{location}/g, currentBarcodeItem.location);
            text = text.replace(/{unit}/g, currentBarcodeItem.unit);
            div.textContent = text;
        }

        div.style.top = `${elementData.top}px`;
        div.style.left = `${elementData.left}px`;

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

    // Vẽ lại barcode nếu có mã hàng được chọn
    if (currentBarcodeItem) {
        renderBarcodeLabel();
    }
}

// Thêm vào file warehouse.js
let html5QrcodeScanner = null;
let audioContext = null;
let printBarcodeListenersInitialized = false;

export function loadScanBarcodeSection() {
    document.getElementById('startScanBtn').onclick = startScanner;
    document.getElementById('stopScanBtn').onclick = stopScanner;
    initializeUsbScannerListener();
}

function initializeUsbScannerListener() {
    const input = document.getElementById('usbScannerInput');
    if (!input) return;

    let barcode = '';
    let timerId = null;

    input.addEventListener('keydown', function (e) {
        // Nếu là phím Enter và có dữ liệu trong bộ đệm -> xử lý
        if (e.key === 'Enter') {
            e.preventDefault(); // Ngăn hành vi mặc định (ví dụ: submit form)
            if (barcode.length > 2) { // Chỉ xử lý nếu mã có độ dài hợp lý
                processUsbScan(barcode);
            }
            barcode = ''; // Xóa bộ đệm
            clearTimeout(timerId); // Hủy timer
            return;
        }

        // Nếu là phím khác, thêm vào bộ đệm
        if (e.key.length === 1) { // Chỉ thêm các ký tự đơn
            barcode += e.key;
        }

        // Đặt lại timer sau mỗi lần nhấn phím
        clearTimeout(timerId);
        timerId = setTimeout(() => {
            // Nếu không có phím nào được nhấn trong 100ms, đây là người gõ tay -> xóa bộ đệm
            barcode = '';
        }, 100);
    });

    // Xử lý khi người dùng dán (paste) mã vạch vào
    input.addEventListener('paste', function (e) {
        e.preventDefault();
        const pastedText = (e.clipboardData || window.clipboardData).getData('text');
        if (pastedText.length > 2) {
            processUsbScan(pastedText.trim());
        }
    });
}

async function processUsbScan(decodedText) {
    playScannerSound();
    showToast(`Đã quét mã: ${decodedText}`, 'info');
    document.getElementById('usbScannerInput').value = '';
    document.getElementById('usbScannerInput').focus();

    const resultContainer = document.getElementById('scanResultContainer');
    resultContainer.innerHTML = `
        <div class="text-center mt-4">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="text-muted mt-2">Đang tìm kiếm thông tin...</p>
        </div>`;

    try {
        // === BẮT ĐẦU LOGIC MỚI CHO QC ===
        if (userRole === 'qc') {
            // Ưu tiên 1: Tìm xem mã hàng này có đang chờ QC không
            const pendingItem = await getPendingImportItem(decodedText);

            if (pendingItem) {
                // Nếu có, hiển thị giao diện duyệt QC
                showQcPendingItemDetails(pendingItem.transactionId, pendingItem.item, pendingItem.itemIndex);
                return; // Dừng xử lý tại đây
            }
        }
        // === KẾT THÚC LOGIC MỚI CHO QC ===

        // Nếu không phải QC, hoặc QC quét mã không cần duyệt, thì chạy logic cũ
        const q = query(collection(db, 'inventory'), where('code', '==', decodedText));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            resultContainer.innerHTML = `<div class="alert alert-danger">Mã hàng <strong>"${decodedText}"</strong> không tồn tại trong kho.</div>`;
            return;
        }

        const itemsFromScan = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (userRole === 'qc') {
            // Kịch bản 2 của QC: Mã hàng có tồn kho nhưng không cần duyệt
            showQcScanResult(itemsFromScan);
        } else {
            // Logic cho các vai trò khác (Admin, Staff)
            const isSessionActive = document.getElementById('scan-export-form');
            if (isSessionActive) {
                addItemToScanExportSession(itemsFromScan);
            } else {
                startNewScanExportSession(itemsFromScan);
            }
        }

    } catch (error) {
        console.error("Lỗi xử lý mã quét:", error);
        resultContainer.innerHTML = `<div class="alert alert-danger">Lỗi truy vấn dữ liệu mã hàng.</div>`;
        showToast('Lỗi truy vấn dữ liệu mã hàng.', 'danger');
    }
}

function showQcPendingItemDetails({ transactionId, item, itemIndex, transactionData }) {
    const resultContainer = document.getElementById('scanResultContainer');
    
    resultContainer.innerHTML = `
        <div class="card border-warning">
            <div class="card-header bg-warning text-dark">
                <h5 class="mb-0"><i class="fas fa-clipboard-check"></i> Yêu cầu Kiểm tra Chất lượng</h5>
            </div>
            <div class="card-body">
                <div class="alert alert-warning">
                    <strong>Mã hàng này đang chờ bạn kiểm tra từ phiếu nhập dưới đây.</strong>
                </div>
                
                <h6 class="text-muted">Thông tin Phiếu nhập</h6>
                <p class="ms-2"><strong>Số phiếu:</strong> ${transactionData.importNumber}<br>
                <strong>Nhà cung cấp:</strong> ${transactionData.supplier}</p>
                
                <hr>

                <h6 class="text-muted">Thông tin Mã hàng cần kiểm tra</h6>
                <div class="row align-items-center">
                    <div class="col-md-8">
                        <p class="ms-2 mb-1"><strong>Mã hàng:</strong> ${item.code}</p>
                        <p class="ms-2 mb-1"><strong>Tên:</strong> ${item.name}</p>
                        <p class="ms-2 mb-0"><strong>Số lượng cần kiểm:</strong> <span class="badge bg-primary fs-6">${item.quantity} ${item.unit}</span></p>
                    </div>
                    <div class="col-md-4 mt-3 mt-md-0">
                        <div class="d-grid gap-2">
                            <button class="btn btn-success" onclick="approveQcItem('${transactionId}', ${itemIndex})">
                                <i class="fas fa-check-circle"></i> Đạt
                            </button>
                            <button class="btn btn-danger" onclick="rejectQcItem('${transactionId}', ${itemIndex})">
                                <i class="fas fa-times-circle"></i> Không đạt
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function getPendingImportItem(itemCode) {
    try {
        const q = query(collection(db, 'transactions'), where('type', '==', 'import'));
        const snapshot = await getDocs(q);

        for (const doc of snapshot.docs) {
            const transactionData = doc.data();
            const transactionId = doc.id;
            
            if (transactionData.items && Array.isArray(transactionData.items)) {
                const itemIndex = transactionData.items.findIndex(item => 
                    item.code === itemCode && item.qc_status === 'pending'
                );

                if (itemIndex !== -1) {
                    // Tìm thấy! Trả về thông tin cần thiết.
                    return {
                        transactionId: transactionId,
                        item: transactionData.items[itemIndex],
                        itemIndex: itemIndex,
                        transactionData: transactionData // Thêm cả dữ liệu phiếu nhập
                    };
                }
            }
        }
        return null; // Không tìm thấy mã hàng nào đang chờ
    } catch (error) {
        console.error("Lỗi khi tìm kiếm mã hàng chờ QC:", error);
        return null;
    }
}

function startScanner() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Nếu context bị tạm dừng (do chính sách của trình duyệt), hãy kích hoạt lại
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    // ---------------------------------------------

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

// File: js/warehouse.js

function showQcScanResult(items) {
    const resultContainer = document.getElementById('scanResultContainer');

    // === SỬA LẠI TIÊU ĐỀ CHO RÕ NGHĨA ===
    let html = `
        <div class="d-flex justify-content-between align-items-center mb-2">
            <h6 class="mb-0">Thông tin tồn kho: <span class="badge bg-primary">${items[0].code}</span></h6>
            <span class="badge bg-info"><i class="fas fa-eye me-1"></i>Quyền: Chỉ xem</span>
        </div>
    `;

    // Phần còn lại của hàm giữ nguyên
    html += items.map(item => `
        <div class="card mb-2">
            <div class="card-body p-3">
                <h5 class="card-title text-primary">${item.name}</h5>
                <hr class="my-2">
                <div class="row">
                    <div class="col-sm-6">
                        <p class="mb-1"><strong>Vị trí:</strong> <span class="badge bg-secondary fs-6">${item.location}</span></p>
                    </div>
                    <div class="col-sm-6">
                        <p class="mb-1"><strong>Tồn kho tại đây:</strong> <span class="badge bg-success fs-6">${item.quantity} ${item.unit}</span></p>
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    resultContainer.innerHTML = html;
}


async function onScanSuccess(decodedText, decodedResult) {
    stopScanner(); // Luôn dừng camera ngay khi có kết quả
    await processUsbScan(decodedText);
}

function startNewScanExportSession(items) {
    // Reset danh sách mỗi khi bắt đầu phiên mới
    exportItemsList = [];
    const scanResultContainer = document.getElementById('scanResultContainer');

    // Lấy mã hàng ở vị trí có tồn kho nhiều nhất để thêm vào đầu tiên
    const itemToAdd = items.sort((a, b) => b.quantity - a.quantity)[0];
    if (itemToAdd.quantity <= 0) {
        showToast(`Mã hàng "${itemToAdd.code}" đã hết hàng.`, 'warning');
        return;
    }

    // Thêm mã hàng đầu tiên vào danh sách
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

            <!-- DANH SÁCH mã hàng -->
            <div class="form-section-compact mt-3 p-3">
                <div class="form-section-header-compact mb-2">
                    <i class="fas fa-list-ul"></i>
                    Danh sách mã hàng
                    <span class="badge bg-warning text-dark ms-auto" id="scan-item-count-badge">0 mã hàng</span>
                </div>
                <div class="table-responsive" style="max-height: 300px;">
                    <table class="table table-sm table-bordered table-hover table-compact">
                        <thead class="table-light">
                            <tr>
                                <th>Mã hàng</th>
                                <th style="width:120px;">SL Xuất</th>
                                <th style="width:50px;" class="text-center"><i class="fas fa-cog"></i></th>
                            </tr>
                        </thead>
                        <tbody id="scan-export-table-body">
                            <!-- Các dòng mã hàng sẽ được thêm vào đây -->
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

    // Vẽ danh sách mã hàng và cập nhật bộ đếm
    renderScanExportTableBody();
}

function updateScanItemCount() {
    const badge = document.getElementById('scan-item-count-badge');
    if (badge) {
        badge.textContent = `${exportItemsList.length} mã hàng`;
    }
}
window.cancelScanExportSession = function () {
    exportItemsList = [];
    const scanResultContainer = document.getElementById('scanResultContainer');
    scanResultContainer.innerHTML = '<p class="text-muted">Chưa có kết quả. Vui lòng hướng camera vào mã vạch.</p>';
    showToast('Phiên xuất kho đã được hủy.', 'info');
}

function addItemToScanExportSession(items) {
    const itemToAdd = items.sort((a, b) => b.quantity - a.quantity)[0];
    if (itemToAdd.quantity <= 0) {
        showToast(`Mã hàng "${itemToAdd.code}" đã hết hàng.`, 'warning');
        return;
    }

    // Kiểm tra xem mã hàng đã có trong danh sách chưa
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

    // Cập nhật lại bảng danh sách mã hàng
    renderScanExportTableBody();
}

// Thay thế hàm renderScanExportTableBody() cũ
function renderScanExportTableBody() {
    const tbody = document.getElementById('scan-export-table-body');
    if (!tbody) return;

    if (exportItemsList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted p-3">Chưa có mã hàng nào.</td></tr>';
    } else {
        const tableHtml = exportItemsList.map((item, index) => `
            <tr>
                <td>
                    <strong>${item.code}</strong><br>
                    <small class="text-muted">${item.name} </small>
                </td>
                <td>
                    <input type="number" class="form-control form-control-sm" 
                           value="${item.requestedQuantity}" min="1" max="${item.availableQuantity}"
                           onchange="updateExportItemQuantity(${index}, this.value)">
                    <small class="text-muted">Tồn: ${item.availableQuantity} - Vị trí: ${item.location}</small>
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

function playScannerSound() {
    // Chỉ thực hiện nếu AudioContext đã được khởi tạo
    if (!audioContext) {
        console.warn('AudioContext chưa được khởi tạo. Âm thanh sẽ không phát.');
        return;
    }

    // Tạo một Oscillator (bộ tạo sóng âm)
    const oscillator = audioContext.createOscillator();
    // Tạo một GainNode (bộ điều khiển âm lượng)
    const gainNode = audioContext.createGain();

    // Kết nối các node với nhau: Oscillator -> Gain -> Loa
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Thiết lập các thông số cho âm thanh "bíp"
    oscillator.type = 'sine'; // Sóng sine cho âm thanh sạch, giống tiếng bíp
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // Tần số nốt A5

    // Tạo hiệu ứng "bíp" ngắn bằng cách giảm âm lượng nhanh chóng
    gainNode.gain.setValueAtTime(1, audioContext.currentTime); // Bắt đầu với 50% âm lượng
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.2); // Giảm dần về 0 sau 0.1 giây

    // Bắt đầu và dừng Oscillator để tạo âm thanh
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
}

// Biến toàn cục để quản lý modal xuất kho
let currentExportModal = null;
let exportItemsList = [];

window.updateExportItemQuantity = (index, newQty) => {
    const qty = parseInt(newQty);
    const item = exportItemsList[index];

    // Chỉ cập nhật nếu số lượng hợp lệ
    if (qty > 0 && qty <= item.availableQuantity) {
        item.requestedQuantity = qty;
    } else {
        // Nếu không hợp lệ, chỉ cần vẽ lại bảng, ô input sẽ tự động
        // được reset về giá trị cũ trong mảng (item.requestedQuantity)
        showToast('Số lượng không hợp lệ!', 'warning');
    }

    // Luôn vẽ lại bảng để cập nhật giao diện
    renderScanExportTableBody();
};

window.removeExportItemFromList = (index) => {
    exportItemsList.splice(index, 1);
    // Vẽ lại bảng và cập nhật bộ đếm
    renderScanExportTableBody();
};

// Thay thế toàn bộ hàm cũ bằng phiên bản mới này
window.finalizeExport = async function () {
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
        confirmTitle, `Bạn có chắc muốn ${actionText.toLowerCase()} cho <strong>${exportItemsList.length}</strong> mã hàng?`,
        actionText, 'Hủy', confirmType
    );
    if (!confirmed) return;

    // === SỬA LỖI Ở ĐÂY: Thêm các giá trị dự phòng để tránh lỗi 'undefined' ===
    const itemsToSave = exportItemsList.map(item => ({
        inventoryId: item.inventoryId || '',
        code: item.code || '',
        name: item.name || '',
        unit: item.unit || '', // Quan trọng: Nếu item.unit là undefined, nó sẽ là ''
        location: item.location || '', // Quan trọng: Nếu item.location là undefined, nó sẽ là ''
        quantity: item.requestedQuantity || 0,
        availableQuantityBefore: item.availableQuantity || 0
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
                items: itemsToSave // Gửi đi dữ liệu đã được làm sạch
            });
            showToast('Đã gửi yêu cầu xuất kho thành công!', 'success');
            cancelScanExportSession();
        } catch (error) {
            console.error("Lỗi khi tạo yêu cầu xuất kho:", error);
            showToast('Đã xảy ra lỗi khi gửi yêu cầu. Vui lòng kiểm tra lại thông tin.', 'danger');
        }
    } else { // Dành cho Admin và Super Admin
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


window.viewItemHistoryFromScan = async function (itemCode) {
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

window.viewInventoryDetailsFromScan = async function (inventoryId) {
    const docSnap = await getDoc(doc(db, 'inventory', inventoryId));
    if (docSnap.exists()) {
        createScannedItemDetailsModal(docSnap.data());
    }
}

window.showImportFromScan = function (itemJson) {
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

window.showExportFromScan = function (inventoryId, currentStock) {
    showExportModal(); // Mở modal xuất kho

    // Đợi modal được tạo rồi điền thông tin
    setTimeout(async () => {
        const docSnap = await getDoc(doc(db, 'inventory', inventoryId));
        if (docSnap.exists()) {
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

window.editInventoryItem = function (item) {
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

function createEditInventoryModal(item) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editInventoryModal';
    modal.setAttribute('tabindex', '-1');

    // --- CHUẨN BỊ DỮ LIỆU CHO CÁC Ô CHỌN ---

    // 1. Đơn vị tính
    const unitOptions = Array.from(unitCache).sort().map(u =>
        `<option value="${u}" ${item.unit === u ? 'selected' : ''}>${u}</option>`
    ).join('');

    // 2. Vị trí
    // Phân tích vị trí hiện tại (ví dụ: "A1-02")
    const locationRegex = /^([A-Z])(\d+)-(\d+)$/;
    const match = item.location.match(locationRegex);
    const currentAisle = match ? match[1] : '';
    const currentBay = match ? parseInt(match[2], 10) : '';
    const currentLevel = match ? parseInt(match[3], 10) : '';

    // Tạo options cho Dãy
    const aisleOptions = layoutConfig.aisles.map(a =>
        `<option value="${a}" ${currentAisle === a ? 'selected' : ''}>${a}</option>`
    ).join('');

    // Tạo options cho Kệ
    let bayOptions = '';
    for (let i = 1; i <= layoutConfig.maxBay; i++) {
        bayOptions += `<option value="${i}" ${currentBay === i ? 'selected' : ''}>Kệ ${i}</option>`;
    }

    // Tạo options cho Tầng
    let levelOptions = '';
    for (let i = 1; i <= layoutConfig.maxLevel; i++) {
        levelOptions += `<option value="${i}" ${currentLevel === i ? 'selected' : ''}>Tầng ${i}</option>`;
    }

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-warning text-dark">
                    <h5 class="modal-title"><i class="fas fa-edit"></i> Sửa thông tin mã hàng</h5>
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
                            <!-- === THAY ĐỔI ĐƠN VỊ TÍNH === -->
                            <div class="col-md-6">
                                <label for="editItemUnit" class="form-label">Đơn vị tính</label>
                                <select class="form-select" id="editItemUnit">${unitOptions}</select>
                            </div>
                            <!-- === KẾT THÚC THAY ĐỔI ĐƠN VỊ TÍNH === -->

                            <div class="col-md-6">
                                <label for="editItemCategory" class="form-label">Danh mục</label>
                                <input type="text" class="form-control" id="editItemCategory" value="${item.category}">
                            </div>
                        </div>
                        <div class="row mt-3">
                            <!-- === THAY ĐỔI VỊ TRÍ === -->
                            <div class="col-md-12">
                                <label class="form-label">Vị trí</label>
                                <div class="row">
                                    <div class="col-md-4">
                                    <small class="form-label">Chọn dãy</small>
                                    <select class="form-select" id="editAisle">${aisleOptions}</select>
                                    </div>
                                    <div class="col-md-4">
                                    <small class="form-label">Chọn kệ</small>
                                    <select class="form-select" id="editBay">${bayOptions}</select>
                                    </div>
                                    <div class="col-md-4">
                                    <small class="form-label">Chọn tầng</small>
                                    <select class="form-select" id="editLevel">${levelOptions}</select>
                                    </div>
                                </div>
                            </div>
                            <!-- === KẾT THÚC THAY ĐỔI VỊ TRÍ === -->
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

window.saveInventoryChanges = async function (itemId) {
    // Lấy giá trị từ các ô chọn vị trí mới
    const aisle = document.getElementById('editAisle').value;
    const bay = document.getElementById('editBay').value;
    const level = document.getElementById('editLevel').value;

    if (!aisle || !bay || !level) {
        return showToast('Vui lòng chọn đầy đủ thông tin vị trí.', 'warning');
    }

    // Tạo chuỗi vị trí mới
    const newLocationString = `${aisle}${bay}-${level.toString().padStart(2, '0')}`;

    const newUpdateData = {
        name: document.getElementById('editItemName').value.trim(),
        unit: document.getElementById('editItemUnit').value, // Lấy từ select
        category: document.getElementById('editItemCategory').value.trim(),
        location: newLocationString, // Sử dụng chuỗi vị trí mới
    };

    if (!newUpdateData.name) {
        showToast('Tên mô tả không được để trống.', 'warning');
        return;
    }

    try {
        const itemRef = doc(db, 'inventory', itemId);
        const originalDoc = await getDoc(itemRef);
        const originalData = originalDoc.data();

        const changes = {};
        if (originalData.name !== newUpdateData.name) changes.name = { from: originalData.name, to: newUpdateData.name };
        if (originalData.unit !== newUpdateData.unit) changes.unit = { from: originalData.unit, to: newUpdateData.unit };
        if (originalData.category !== newUpdateData.category) changes.category = { from: originalData.category, to: newUpdateData.category };
        if (originalData.location !== newUpdateData.location) changes.location = { from: originalData.location, to: newUpdateData.location };

        if (Object.keys(changes).length === 0) {
            showToast('Không có thay đổi nào để lưu.', 'info');
            return;
        }

        const batch = writeBatch(db);
        batch.update(itemRef, newUpdateData);

        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'inventory_edited',
            inventoryId: itemId,
            itemCode: originalData.code,
            changes: changes,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Cập nhật thông tin mã hàng thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editInventoryModal')).hide();

        if (window.loadInventoryTable) {
            window.loadInventoryTable(true, 1);
        }

    } catch (error) {
        console.error("Lỗi cập nhật mã hàng:", error);
        showToast('Đã xảy ra lỗi khi cập nhật.', 'danger');
    }
};

window.deleteInventoryItem = async function (itemId, itemCode, quantity) {
    if (userRole !== 'super_admin') {
        showToast('Bạn không có quyền thực hiện thao tác này.', 'danger');
        return;
    }

    if (quantity > 0) {
        showToast(`Không thể xóa mã hàng "${itemCode}" vì vẫn còn ${quantity} tồn kho.`, 'danger');
        return;
    }

    const confirmed = await showConfirmation(
        'Xác nhận xóa mã hàng',
        `Bạn có chắc muốn XÓA (lưu trữ) mã hàng <strong>${itemCode}</strong>? mã hàng sẽ bị ẩn khỏi danh sách tồn kho.`,
        'Xóa (lưu trữ)', 'Hủy', 'danger'
    );

    if (!confirmed) return;

    try {
        const itemRef = doc(db, 'inventory', itemId);
        const batch = writeBatch(db);

        // 1. Đánh dấu mã hàng là đã lưu trữ
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
            details: `Mã hàng ${itemCode} đã được xóa (lưu trữ).`,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast(`Đã xóa (lưu trữ) mã hàng "${itemCode}" thành công.`, 'success');

        if (window.loadInventoryTable) {
            window.loadInventoryTable(true, 1);
        }

    } catch (error) {
        console.error("Lỗi xóa mã hàng:", error);
        showToast('Đã xảy ra lỗi khi xóa mã hàng.', 'danger');
    }
};

window.viewInventoryArchiveDetails = async function (transactionId) {
    const transSnap = await getDoc(doc(db, 'transactions', transactionId));
    if (!transSnap.exists()) return showToast('Không tìm thấy lịch sử.', 'danger');

    const data = transSnap.data();
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
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

// File: js/warehouse.js

window.approveQcItem = async function (transactionId, itemIndex) {
    if (userRole !== 'qc') return;

    try {
        const transRef = doc(db, 'transactions', transactionId);
        const transSnap = await getDoc(transRef);
        if (!transSnap.exists()) throw new Error("Không tìm thấy phiếu nhập.");

        const transactionData = transSnap.data();
        const item = transactionData.items[itemIndex];

        if (item.qc_status !== 'pending') {
            showToast('Mã hàng này đã được xử lý.', 'info');
            return;
        }

        const batch = writeBatch(db);

        // Cập nhật trạng thái item trong phiếu nhập
        transactionData.items[itemIndex].qc_status = 'passed';
        transactionData.items[itemIndex].qc_by_id = currentUser.uid;
        transactionData.items[itemIndex].qc_by_name = currentUser.name;
        batch.update(transRef, { items: transactionData.items });

        // Tìm và cập nhật tồn kho
        const q = query(
            collection(db, 'inventory'),
            where('code', '==', item.code),
            where('location', '==', item.location)
        );
        const inventorySnap = await getDocs(q);

        if (inventorySnap.empty) {
            const newInventoryDoc = doc(collection(db, 'inventory'));
            batch.set(newInventoryDoc, {
                code: item.code, name: item.name, unit: item.unit,
                quantity: item.quantity, category: item.category,
                location: item.location, createdAt: serverTimestamp()
            });
        } else {
            const inventoryDocRef = inventorySnap.docs[0].ref;
            batch.update(inventoryDocRef, { quantity: increment(item.quantity) });
        }

        await batch.commit();
        showToast(`Đã duyệt "${item.code}". Hàng đã được nhập kho.`, 'success');

        // === BẮT ĐẦU THAY ĐỔI QUAN TRỌNG ===
        // Sau khi xử lý xong, tự động tìm và hiển thị thông tin tồn kho của mã hàng đó
        const updatedInventoryQuery = query(collection(db, 'inventory'), where('code', '==', item.code));
        const updatedSnapshot = await getDocs(updatedInventoryQuery);
        if (!updatedSnapshot.empty) {
            const updatedItems = updatedSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            showQcScanResult(updatedItems); // Gọi hàm hiển thị thông tin tồn kho
        } else {
            const resultContainer = document.getElementById('scanResultContainer');
            resultContainer.innerHTML = `<div class="alert alert-info">Đã xử lý xong. Không tìm thấy thông tin tồn kho cho mã này.</div>`;
        }
        // === KẾT THÚC THAY ĐỔI QUAN TRỌNG ===

    } catch (error) {
        console.error("Lỗi khi duyệt QC:", error);
        showToast('Lỗi nghiêm trọng khi duyệt QC.', 'danger');
    }
}

// File: js/warehouse.js

window.rejectQcItem = async function (transactionId, itemIndex) {
    if (userRole !== 'qc') return;

    const confirmed = await showConfirmation(
        'Xác nhận hàng không đạt',
        'Bạn có chắc chắn mã hàng này không đạt chất lượng? Hàng sẽ không được nhập kho.',
        'Xác nhận không đạt', 'Hủy', 'danger'
    );
    if (!confirmed) return;

    try {
        const transRef = doc(db, 'transactions', transactionId);
        const transSnap = await getDoc(transRef);
        if (!transSnap.exists()) throw new Error("Không tìm thấy phiếu nhập.");

        const transactionData = transSnap.data();
        const item = transactionData.items[itemIndex];

        if (item.qc_status !== 'pending') {
            showToast('Mã hàng này đã được xử lý.', 'info');
            return;
        }

        // Cập nhật trạng thái trong phiếu nhập
        transactionData.items[itemIndex].qc_status = 'failed';
        transactionData.items[itemIndex].qc_by_id = currentUser.uid;
        transactionData.items[itemIndex].qc_by_name = currentUser.name;
        await updateDoc(transRef, { items: transactionData.items });

        showToast(`Đã đánh dấu "${item.code}" là không đạt.`, 'success');

        // === BẮT ĐẦU THAY ĐỔI QUAN TRỌNG ===
        // Sau khi xử lý xong, tự động tìm và hiển thị thông tin tồn kho của mã hàng đó
        const inventoryQuery = query(collection(db, 'inventory'), where('code', '==', item.code));
        const snapshot = await getDocs(inventoryQuery);
        if (!snapshot.empty) {
            const inventoryItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            showQcScanResult(inventoryItems); // Gọi hàm hiển thị thông tin tồn kho
        } else {
            const resultContainer = document.getElementById('scanResultContainer');
            resultContainer.innerHTML = `<div class="alert alert-info">Đã xử lý xong. Mã hàng này hiện chưa có tồn kho.</div>`;
        }
        // === KẾT THÚC THAY ĐỔI QUAN TRỌNG ===

    } catch (error) {
        console.error("Lỗi khi từ chối QC:", error);
        showToast('Lỗi khi từ chối QC.', 'danger');
    }
}


// Thay thế hàm này trong warehouse.js
window.startReplacementProcess = async function (transactionId) {
    const replacementBtn = document.getElementById('replacementBtn');
    if (replacementBtn) {
        replacementBtn.disabled = true;
        replacementBtn.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Đang xử lý...
        `;
    }

    try {
        const transRef = doc(db, 'transactions', transactionId);
        const transSnap = await getDoc(transRef);
        if (!transSnap.exists()) throw new Error("Không tìm thấy phiếu nhập gốc.");

        const originalData = transSnap.data();
        const failedItems = originalData.items.filter(item => item.qc_status === 'failed');

        if (failedItems.length === 0) {
            if (replacementBtn) {
                replacementBtn.disabled = false;
                replacementBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Nhà cung cấp đã giao bù hàng';
            }
            return showToast('Không có mã hàng nào cần xử lý trong phiếu này.', 'info');
        }

        const updatedItems = originalData.items.map(item => {
            if (item.qc_status === 'failed') {
                return { ...item, qc_status: 'replaced' };
            }
            return item;
        });

        // Cập nhật tài liệu gốc trên Firestore
        await updateDoc(transRef, { items: updatedItems });

        // Đóng modal hiện tại
        const currentModal = document.querySelector('.modal');
        if (currentModal) {
            bootstrap.Modal.getInstance(currentModal).hide();
        }

        // Mở modal nhập kho mới cho hàng bù
        showImportModal();

        setTimeout(() => {
            document.getElementById('importNumber').value = `${originalData.importNumber}-BU`;
            document.getElementById('supplier').value = originalData.supplier;
            currentImportItems = failedItems.map(item => ({ ...item, qc_status: 'pending' }));
            updateImportItemsTable();
            updateSaveButtonState();
            showToast('Đang tạo phiếu nhập cho hàng giao bù.', 'info');
        }, 500);

    } catch (error) {
        console.error("Lỗi khi bắt đầu quy trình hàng bù:", error);
        showToast('Lỗi khi xử lý hàng bù.', 'danger');

        if (replacementBtn) {
            replacementBtn.disabled = false;
            replacementBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Nhà cung cấp đã giao bù hàng';
        }
    }
}

// Thêm các hàm này vào cuối file warehouse.js

/**
 * Xử lý sự kiện khi nhấn checkbox "chọn tất cả".
 * @param {HTMLInputElement} source - Checkbox "chọn tất cả".
 * @param {string} checkboxClassName - Lớp CSS của các checkbox con.
 */
window.toggleSelectAll = function (source, checkboxClassName) {
    const checkboxes = document.getElementsByClassName(checkboxClassName);
    for (let i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = source.checked;
    }
    updateBatchActionUI();
};

/**
 * Cập nhật giao diện của khu vực hành động hàng loạt (hiện/ẩn và đếm số lượng).
 */
window.updateBatchActionUI = function () {
    const selectedCheckboxes = document.querySelectorAll('.adjustRequestCheckbox:checked');
    const container = document.querySelector('.batch-action-container');
    const countSpan = document.getElementById('batchActionCount');

    if (container && countSpan) {
        if (selectedCheckboxes.length > 0) {
            container.style.display = 'block';
            countSpan.textContent = `Đã chọn: ${selectedCheckboxes.length}`;
        } else {
            container.style.display = 'none';
        }
    }

    // Bỏ check ô "chọn tất cả" nếu không phải tất cả đều được chọn
    const allCheckboxes = document.querySelectorAll('.adjustRequestCheckbox');
    const selectAllCheckbox = document.getElementById('selectAllAdjustRequests');
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = allCheckboxes.length > 0 && selectedCheckboxes.length === allCheckboxes.length;
    }
};

/**
 * Xử lý logic duyệt hoặc từ chối hàng loạt các yêu cầu đã chọn.
 * @param {string} action - Hành động cần thực hiện ('approve' hoặc 'reject').
 */
window.processBatchAdjustRequests = async function (action) {
    const selectedCheckboxes = document.querySelectorAll('.adjustRequestCheckbox:checked');
    if (selectedCheckboxes.length === 0) {
        return showToast('Vui lòng chọn ít nhất một yêu cầu để xử lý.', 'warning');
    }

    const requestIds = Array.from(selectedCheckboxes).map(cb => cb.value);
    const actionText = action === 'approve' ? 'duyệt' : 'từ chối';
    const confirmTitle = action === 'approve' ? 'Xác nhận Duyệt hàng loạt' : 'Xác nhận Từ chối hàng loạt';

    let reason = '';
    // Nếu là từ chối, yêu cầu nhập lý do chung
    if (action === 'reject') {
        reason = await showInputModal(
            'Lý do từ chối hàng loạt',
            'Vui lòng nhập lý do chung cho tất cả các yêu cầu bị từ chối:',
            'VD: Yêu cầu không hợp lệ...',
            'text'
        );
        if (!reason) return; // Người dùng đã hủy
    }

    const confirmed = await showConfirmation(
        confirmTitle,
        `Bạn có chắc muốn ${actionText} <strong>${requestIds.length}</strong> yêu cầu đã chọn?`,
        action === 'approve' ? 'Duyệt tất cả' : 'Từ chối tất cả',
        'Hủy',
        action === 'approve' ? 'success' : 'danger'
    );

    if (!confirmed) return;

    try {
        const batch = writeBatch(db);
        let processedCount = 0;

        for (const requestId of requestIds) {
            const requestRef = doc(db, 'adjustment_requests', requestId);
            const requestSnap = await getDoc(requestRef);
            if (!requestSnap.exists() || requestSnap.data().status !== 'pending') {
                console.warn(`Yêu cầu ${requestId} đã được xử lý hoặc không tồn tại.`);
                continue;
            }

            const requestData = requestSnap.data();

            if (action === 'approve') {
                // Logic duyệt
                const inventoryRef = doc(db, 'inventory', requestData.inventoryId);
                batch.update(inventoryRef, { quantity: requestData.requestedQuantity });
                batch.update(requestRef, { status: 'approved', approvedBy: currentUser.uid, approvedByName: currentUser.name, approvedDate: serverTimestamp() });

                const transactionRef = doc(collection(db, 'transactions'));
                batch.set(transactionRef, {
                    type: 'adjust', inventoryId: requestData.inventoryId, itemCode: requestData.itemCode,
                    itemName: requestData.itemName, location: requestData.location,
                    previousQuantity: requestData.currentQuantity, newQuantity: requestData.requestedQuantity,
                    adjustment: requestData.adjustment, reason: requestData.reason, requestId: requestId,
                    performedBy: currentUser.uid, performedByName: currentUser.name,
                    date: serverTimestamp(), timestamp: serverTimestamp()
                });
            } else { // action === 'reject'
                // Logic từ chối
                batch.update(requestRef, { status: 'rejected', rejectedBy: currentUser.uid, rejectedByName: currentUser.name, rejectedDate: serverTimestamp(), rejectionReason: reason });
            }
            processedCount++;
        }

        await batch.commit();
        showToast(`Đã ${actionText} thành công ${processedCount} yêu cầu.`, 'success');
        // Danh sách sẽ tự cập nhật nhờ onSnapshot, không cần gọi lại loadPendingAdjustments()

    } catch (error) {
        console.error(`Lỗi khi ${actionText} hàng loạt:`, error);
        showToast(`Đã xảy ra lỗi khi ${actionText} hàng loạt.`, 'danger');
    }
};

function downloadQuickPrintTemplate() {
    const data = [
        ['Mã hàng', 'vị trí'], // Các tiêu đề cột
        ['SP001', 'A1-01'],
        ['SP002', 'B3-04']
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 20 }, { wch: 20 }]; // Đặt độ rộng cho cột
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_In_Nhanh');
    XLSX.writeFile(wb, 'mau-in-nhanh-barcode.xlsx');
    showToast('Đã tải xuống file mẫu.', 'success');
}

/**
 * Xử lý file Excel sau khi người dùng chọn.
 * @param {Event} event - Sự kiện từ file input.
 */
function handleQuickPrintExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            // Đọc dữ liệu và bỏ qua dòng tiêu đề (slice(1))
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }).slice(1);

            const itemsToPrint = data
                .filter(row => row[0] && row[1]) // Chỉ lấy các dòng có cả mã hàng và vị trí
                .map(row => ({
                    code: row[0].toString().trim(),
                    location: row[1].toString().trim()
                }));

            if (itemsToPrint.length === 0) {
                showToast('File Excel không có dữ liệu hợp lệ.', 'warning');
                return;
            }

            showToast(`Đang chuẩn bị ${itemsToPrint.length} tem để in...`, 'info');
            generateBatchPrintPage(itemsToPrint);

        } catch (error) {
            console.error('Lỗi đọc file Excel:', error);
            showToast('Đã xảy ra lỗi khi đọc file Excel.', 'danger');
        } finally {
            event.target.value = ''; // Reset file input để có thể chọn lại file cũ
        }
    };
    reader.readAsBinaryString(file);
}

/**
 * Lấy dữ liệu mã hàng và tạo ra một trang HTML để in hàng loạt.
 * @param {Array<Object>} items - Mảng các đối tượng {code, location}.
 */
async function generateBatchPrintPage(items) {
    // 1. Lấy dữ liệu đầy đủ của tất cả mã hàng từ Firestore
    const dataPromises = items.map(item => {
        const q = query(collection(db, 'inventory'),
            where('code', '==', item.code),
            where('location', '==', item.location),
            limit(1)
        );
        return getDocs(q);
    });

    const snapshots = await Promise.all(dataPromises);
    const productDataList = snapshots.map((snapshot, index) => {
        if (snapshot.empty) {
            console.warn(`Không tìm thấy mã hàng: Mã ${items[index].code} tại vị trí ${items[index].location}`);
            return null; // Trả về null nếu không tìm thấy
        }
        return snapshot.docs[0].data();
    }).filter(data => data !== null); // Lọc bỏ các mã hàng không tìm thấy

    if (productDataList.length === 0) {
        showToast('Không tìm thấy mã hàng nào hợp lệ từ file Excel.', 'danger');
        return;
    }

    // 2. Lấy layout từ mẫu tem đang được chọn
    const selectedTemplateName = document.getElementById('templateLoader').value;
    let layoutToUse = null;
    if (selectedTemplateName) {
        const template = savedTemplates.find(t => t.name === selectedTemplateName);
        if (template && template.layout) layoutToUse = template.layout;
    }
    if (!layoutToUse) { // Fallback về layout mặc định
        layoutToUse = {
            itemInfo: { text: '{code} - {name}', top: 5, left: 5, type: 'text' },
            stockInfo: { text: 'SL: {quantity} - Vị trí: {location}', top: 30, left: 5, type: 'text' },
            barcode: { type: 'barcode', top: 55, left: 5, width: 2, height: 40 }
        };
    }

    // 3. Lấy kích thước giấy
    const paperSizeValue = document.getElementById('paperSizeSelector').value;
    let widthInches, heightInches;
    if (paperSizeValue === 'custom') {
        widthInches = parseFloat(document.getElementById('customWidthInput').value) || 4;
        heightInches = parseFloat(document.getElementById('customHeightInput').value) || 3;
    } else {
        [widthInches, heightInches] = paperSizeValue.split('x').map(Number);
    }
    const labelWidth = widthInches * INCH_TO_PX;
    const labelHeight = heightInches * INCH_TO_PX;

    // 4. Tạo nội dung HTML cho trang in
    let labelsHtml = '';
    for (const productData of productDataList) {
        let singleLabelContent = '';
        for (const key in layoutToUse) {
            const elementData = layoutToUse[key];
            let content = '';
            if (elementData.type === 'barcode') {
                content = `<svg class="barcode-svg" data-value="${productData.code}" data-width="${elementData.width}" data-height="${elementData.height}"></svg>`;
            } else {
                let text = (elementData.text || '')
                    .replace(/{code}/g, productData.code)
                    .replace(/{name}/g, productData.name)
                    .replace(/{quantity}/g, productData.quantity)
                    .replace(/{location}/g, productData.location)
                    .replace(/{unit}/g, productData.unit);
                content = text;
            }
            singleLabelContent += `<div style="position: absolute; top: ${elementData.top}px; left: ${elementData.left}px;">${content}</div>`;
        }
        labelsHtml += `<div class="label-to-print" style="width: ${labelWidth}px; height: ${labelHeight}px;">${singleLabelContent}</div>`;
    }

    // 5. Mở cửa sổ mới và in
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>In tem hàng loạt</title>
            <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>
            <style>
                @media print {
                    @page { margin: 0; }
                    body { margin: 0; }
                }
                body { font-family: sans-serif; font-size: 10px; }
                .label-to-print {
                    position: relative;
                    overflow: hidden;
                    page-break-after: always; /* In mỗi tem trên một trang mới */
                    border: 1px dashed #ccc; /* Thêm viền để xem trước */
                    margin: 5px;
                }
                .barcode-svg { vertical-align: top; }
            </style>
        </head>
        <body>
            ${labelsHtml}
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    document.querySelectorAll('.barcode-svg').forEach(svg => {
                        JsBarcode(svg, svg.dataset.value, {
                            width: parseFloat(svg.dataset.width),
                            height: parseFloat(svg.dataset.height),
                            displayValue: true
                        });
                    });
                    // Đợi một chút để barcode vẽ xong rồi mới in
                    setTimeout(() => {
                        window.print();
                        window.close();
                    }, 500);
                });
            <\/script>
        </body>
        </html>
    `);
    printWindow.document.close();
}
