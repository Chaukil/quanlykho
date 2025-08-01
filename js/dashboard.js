import {
    showConfirmation,
    loadCacheData,
    initializeWarehouseFunctions,
    loadImportSection,
    loadExportSection,
    loadTransferSection,
    loadAdjustSection,
    loadHistorySection,
    loadPrintBarcodeSection,
    loadScanBarcodeSection,
    debounce,
    hideSuggestions,
} from './warehouse.js';

import { auth, db } from './connect.js';
export let companyInfo = { name: '', address: '' };
export { currentUser, userRole };
import {
    onAuthStateChanged, signOut, EmailAuthProvider,
    reauthenticateWithCredential,
    updatePassword
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    doc,
    getDoc,
    collection,
    query,
    where,
    setDoc,
    getDocs,
    orderBy,
    limit,
    addDoc,
    updateDoc,
    serverTimestamp,
    writeBatch,
    onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { showToast } from './auth.js';

let currentUser = null;
let userRole = null;
let currentDashboardPage = 1;
let dashboardItemsPerPage = 15;
let filteredDashboardData = [];
let allDashboardData = [];
let userSettings = {};
let allUsersCache = [];
let unsubscribeInventory = null;
let unsubscribeUsersListener = null; // Listener cho bảng user
let allUsersData = [];
let currentUsersPage = 1;

let layoutViewerModalInstance = null;
let layoutSettingsModalInstance = null;
let layoutPrintModalInstance = null;
let aisleItemCountChartInstance = null;
let activityChartInstance = null;
let inventoryStatusChartInstance = null;
let topProductsChartInstance = null;
let categoryOverviewChartInstance = null;
let topAdjustedProductsChartInstance = null;

export let layoutConfig = {};
let allInventoryDataForLayout = [];

window.loadInventoryTable = loadInventoryTable;
window.goToDashboardPage = goToDashboardPage;

document.addEventListener('DOMContentLoaded', function () {
    loadCacheData();
    initializeNavigation();
    initializeAuth();
    initializeSettingsListeners();
    initializeWarehouseFunctions();

    // Khởi tạo tất cả các đối tượng Modal một lần duy nhất
    const layoutViewerEl = document.getElementById('layoutViewerModal');
    if (layoutViewerEl) {
        layoutViewerModalInstance = new bootstrap.Modal(layoutViewerEl);
    }
    const layoutSettingsEl = document.getElementById('layoutSettingsModal');
    if (layoutSettingsEl) {
        layoutSettingsModalInstance = new bootstrap.Modal(layoutSettingsEl);
    }
    const layoutPrintEl = document.getElementById('layoutPrintModal');
    if (layoutPrintEl) {
        layoutPrintModalInstance = new bootstrap.Modal(layoutPrintEl);
    }

    document.getElementById('openLayoutViewerBtn')?.addEventListener('click', openLayoutViewer);
    document.getElementById('layoutBackBtn')?.addEventListener('click', goBackToAllAislesView);
});

function goBackToAllAislesView() {
    const activeInventory = allInventoryDataForLayout.filter(item => item.status !== 'archived');
    const backButton = document.getElementById('layoutBackBtn');
    drawAllAislesLayout(activeInventory);
    if (backButton) backButton.style.display = 'none';
}

function goToDashboardPage(page) {
    if (page >= 1) {
        filterAndDisplayInventory(page);
    }
}

function initializeAuth() {
    onAuthStateChanged(auth, async (user) => {
        const maintenanceRef = doc(db, 'settings', 'maintenance');
        onSnapshot(maintenanceRef, (docSnap) => {
            const maintenanceEnabled = docSnap.exists() && docSnap.data().enabled;
            if (maintenanceEnabled && userRole && userRole !== 'super_admin') {
                window.location.href = 'maintenance.html';
            }
        });
        if (!user) {
            window.location.href = 'index.html';
            return;
        }
        const maintenanceDoc = await getDoc(doc(db, 'settings', 'maintenance'));
        const maintenanceMode = maintenanceDoc.exists() && maintenanceDoc.data().enabled;

        // Logic này cần thiết cho trường hợp người dùng đã đăng nhập và làm mới trang
        const userDocForCheck = await getDoc(doc(db, 'users', user.uid));
        const roleForCheck = userDocForCheck.exists() ? userDocForCheck.data().role : 'staff';

        if (maintenanceMode && roleForCheck !== 'super_admin') {
            await signOut(auth); // Đăng xuất họ
            window.location.href = 'maintenance.html'; // Và chuyển đến trang bảo trì
            return;
        }
        try {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (userDoc.exists()) {
                const userData = userDoc.data();

                if (userData.status !== 'approved') {
                    await signOut(auth);
                    window.location.href = 'index.html';
                    return;
                }
                currentUser = { ...userData, uid: user.uid };
                userRole = userData.role;
                await fetchAllUsersForCache();

                await Promise.all([
                    loadCompanyInfo(),
                    fetchLayoutConfiguration()
                ]);
                loadSettings();
                setupUserInterface();
                initializeSidebarToggle();
                // TỰ ĐỘNG TẢI DASHBOARD VÀ BIỂU ĐỒ KHI ĐĂNG NHẬP THÀNH CÔNG
                loadDashboardData();
                initializeAllListeners();
            } else {
                console.log('User doc not found, signing out');
                await signOut(auth);
                window.location.href = 'index.html';
            }
        } catch (error) {
            console.error('Error loading user data:', error);
            showToast('Lỗi tải dữ liệu người dùng', 'danger');
            await signOut(auth);
            window.location.href = 'index.html';
        }
    });
}

async function fetchAllUsersForCache(forceRefresh = false) {
    // SỬA ĐỔI: Chỉ bỏ qua nếu cache đã có VÀ không bị ép buộc tải lại
     if (userRole !== 'admin' && userRole !== 'super_admin') return;
     if (allUsersCache.length > 0 && !forceRefresh) return;

    try {
        const usersQuery = query(collection(db, 'users'), where('status', '==', 'approved'));
        const snapshot = await getDocs(usersQuery);
        allUsersCache = snapshot.docs.map(doc => {
            const userData = doc.data();
            return {
                uid: doc.id,
                name: userData.name,
                email: userData.email,
                position: userData.position || '',
                department: userData.department || '',
                manager: userData.manager || '',
                isHighestAuthority: userData.isHighestAuthority || false
            };
        });
    } catch (error) {
        console.error("Lỗi khi tải danh sách người dùng cho cache:", error);
    }
}

function renderOrganizationChart() {
    if (allUsersCache.length === 0) {
        document.getElementById('orgChartContainer').innerHTML = '<p>Đang tải dữ liệu người dùng...</p>';
        fetchAllUsersForCache().then(() => renderOrganizationChart());
        return;
    }

    // 1. Phân loại người dùng
    const userMap = new Map(allUsersCache.map(user => [user.name, user]));

    // TÌM NGƯỜI CÓ QUYỀN CAO NHẤT
    const highestAuthorityUser = allUsersCache.find(user => user.isHighestAuthority);

    // TÌM NHỮNG NGƯỜI CHƯA PHÂN CÔNG (Không có quản lý VÀ không phải là người cao nhất)
    const unassignedUsers = allUsersCache.filter(user => !user.manager && !user.isHighestAuthority);

    // TÌM NHỮNG NGƯỜI ĐÃ PHÂN CÔNG (Có quản lý hợp lệ)
    const assignedUsers = allUsersCache.filter(user => user.manager && userMap.has(user.manager));

    // 2. Vẽ biểu đồ chính
    drawMainOrgChart(highestAuthorityUser, assignedUsers);

    // 3. Vẽ danh sách bên phải
    renderUnassignedUsersList(unassignedUsers);
}

function drawMainOrgChart(rootUser, assignedUsers) {
    google.charts.load('current', { 'packages': ['orgchart'] });
    google.charts.setOnLoadCallback(drawChart);

    function drawChart() {
        const data = new google.visualization.DataTable();
        data.addColumn('string', 'Name');
        data.addColumn('string', 'Manager');
        data.addColumn('string', 'ToolTip');

        const chartRows = [];

        // THÊM MỚI: Thêm người có quyền cao nhất làm gốc của biểu đồ
        if (rootUser) {
            const nodeHtml = `
                <div class="org-node">
                    <div class="org-node-name">${rootUser.name}</div>
                    <div class="org-node-position">${rootUser.position || 'Chưa có chức vụ'}</div>
                    <hr class="my-1">
                    <div class="org-node-info">
                        <div><i class="fas fa-building fa-fw me-1"></i> ${rootUser.department || 'N/A'}</div>
                        <div><i class="fas fa-envelope fa-fw me-1"></i> ${rootUser.email}</div>
                    </div>
                </div>
            `;
            // Người gốc sẽ có trường 'Manager' là rỗng ''
            chartRows.push([{ v: rootUser.name, f: nodeHtml }, '', rootUser.position || 'Lãnh đạo']);
        }

        // Thêm những người dùng đã phân công còn lại
        assignedUsers.forEach(user => {
            const nodeHtml = `
                <div class="org-node">
                    <div class="org-node-name">${user.name}</div>
                    <div class="org-node-position">${user.position || 'Chưa có chức vụ'}</div>
                    <hr class="my-1">
                    <div class="org-node-info">
                        <div><i class="fas fa-building fa-fw me-1"></i> ${user.department || 'N/A'}</div>
                        <div><i class="fas fa-envelope fa-fw me-1"></i> ${user.email}</div>
                    </div>
                </div>
            `;
            chartRows.push([{ v: user.name, f: nodeHtml }, user.manager, user.position || 'Nhân viên']);
        });

        const chartContainer = document.getElementById('orgChartContainer');
        if (chartRows.length > 0) {
            data.addRows(chartRows);
            const chart = new google.visualization.OrgChart(chartContainer);
            chart.draw(data, { 'allowHtml': true, 'nodeClass': 'org-node' });
            const chartDiv = chartContainer.firstChild; // Phần tử con chứa biểu đồ thực tế
            let currentZoom = 1.0;
            const minZoom = 0.3;
            const maxZoom = 2.0;
            const zoomFactor = 0.1;

            // 1. Logic Phóng to/Thu nhỏ (Zoom)
            chartContainer.addEventListener('wheel', (event) => {
                event.preventDefault(); // Ngăn trang cuộn lên xuống

                if (event.deltaY < 0) { // Scroll lên -> Phóng to
                    currentZoom = Math.min(maxZoom, currentZoom + zoomFactor);
                } else { // Scroll xuống -> Thu nhỏ
                    currentZoom = Math.max(minZoom, currentZoom - zoomFactor);
                }
                chartDiv.style.transform = `scale(${currentZoom})`;
            });

            // 2. Logic Kéo/Di chuyển (Pan)
            let isPanning = false;
            let startX, startY, scrollLeft, scrollTop;

            chartContainer.addEventListener('mousedown', (e) => {
                isPanning = true;
                chartContainer.style.cursor = 'grabbing';
                startX = e.pageX - chartContainer.offsetLeft;
                startY = e.pageY - chartContainer.offsetTop;
                scrollLeft = chartContainer.scrollLeft;
                scrollTop = chartContainer.scrollTop;
            });

            chartContainer.addEventListener('mouseleave', () => {
                isPanning = false;
                chartContainer.style.cursor = 'grab';
            });

            chartContainer.addEventListener('mouseup', () => {
                isPanning = false;
                chartContainer.style.cursor = 'grab';
            });

            chartContainer.addEventListener('mousemove', (e) => {
                if (!isPanning) return;
                e.preventDefault();
                const x = e.pageX - chartContainer.offsetLeft;
                const y = e.pageY - chartContainer.offsetTop;
                const walkX = (x - startX);
                const walkY = (y - startY);
                chartContainer.scrollLeft = scrollLeft - walkX;
                chartContainer.scrollTop = scrollTop - walkY;
            });
        } else {
            chartContainer.innerHTML = '<div class="alert alert-info">Chưa có dữ liệu để vẽ biểu đồ chính. Hãy thiết lập một người dùng có quyền cao nhất.</div>';
        }
    }
}


function renderUnassignedUsersList(users) {
    const container = document.getElementById('unassignedUsersContainer');
    if (!container) return;

    if (users.length === 0) {
        container.innerHTML = '<div class="list-group-item text-muted">Tất cả người dùng đã được phân công.</div>';
        return;
    }

    container.innerHTML = users.map(user => `
        <div class="list-group-item unassigned-user-item">
            <div class="unassigned-user-name">${user.name}</div>
            <div class="unassigned-user-position">${user.position || 'Chưa có chức vụ'}</div>
            <div class="unassigned-user-email">${user.email}</div>
        </div>
    `).join('');
}

async function loadCompanyInfo() {
    try {
        const docRef = doc(db, 'settings', 'companyInfo');
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            companyInfo = docSnap.data();
        } else {
            companyInfo = { name: 'TÊN CÔNG TY', address: 'ĐỊA CHỈ CÔNG TY' };
        }
        const companyNameInput = document.getElementById('companyName');
        const companyAddressInput = document.getElementById('companyAddress');
        if (companyNameInput) companyNameInput.value = companyInfo.name;
        if (companyAddressInput) companyAddressInput.value = companyInfo.address;

    } catch (error) {
        console.error("Lỗi tải thông tin công ty:", error);
        showToast("Không thể tải thông tin công ty.", "danger");
    }
}

async function saveCompanyInfo() {
    const name = document.getElementById('companyName').value.trim();
    const address = document.getElementById('companyAddress').value.trim();
    if (!name || !address) {
        showToast("Vui lòng nhập đầy đủ Tên và Địa chỉ công ty.", "warning");
        return;
    }
    try {
        const docRef = doc(db, 'settings', 'companyInfo');
        await setDoc(docRef, { name, address }, { merge: true });
        companyInfo = { name, address };
        showToast("Đã lưu thông tin công ty thành công!", "success");
    } catch (error) {
        console.error("Lỗi lưu thông tin công ty:", error);
        showToast("Lỗi khi lưu thông tin công ty.", "danger");
    }
}

function setupUserInterface() {
    document.getElementById('userGreeting').textContent = `Hi, ${currentUser.name}`;
    document.querySelectorAll('.admin-only, .super-admin-only, .admin-only-feature, .admin-access').forEach(element => {
        element.style.display = 'none';
    });

    if (userRole === 'staff') {
    } else if (userRole === 'qc') {
        const qcPermissions = ['dashboard', 'history', 'scan-barcode', 'settings', 'import'];
        document.querySelectorAll('.nav-link[data-section]').forEach(link => {
            if (qcPermissions.includes(link.dataset.section)) {
                link.parentElement.style.display = 'block';
            } else {
                link.parentElement.style.display = 'none';
            }
        });
        // Hiển thị cả mục menu cha của barcode
        document.querySelector('#barcodeSubmenu').parentElement.style.display = 'block';
        const buttonsToHideForQc = ['addImportBtn', 'importExcel', 'downloadTemplate'];
        buttonsToHideForQc.forEach(id => {
            const button = document.getElementById(id);
            if (button) {
                // Thay vì ẩn hoàn toàn, chúng ta có thể làm cho nó biến mất khỏi layout
                button.style.display = 'none';
            }
        });

    } else if (userRole === 'admin') {
        document.querySelectorAll('.admin-only, .admin-access, .admin-only-feature').forEach(element => {
            element.style.display = 'block';
        });
    } else if (userRole === 'super_admin') {
        document.querySelectorAll('.admin-only, .super-admin-only, .admin-access, .admin-only-feature').forEach(element => {
            element.style.display = 'block';
        });
    }

    document.getElementById('profileBtn').addEventListener('click', (e) => {
        e.preventDefault();
        showUserProfileModal();
    });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
        try {
            await signOut(auth);
            window.location.href = 'index.html';
        } catch (error) {
            showToast('Lỗi đăng xuất', 'danger');
        }
    });
}

function initializeNavigation() {
    const navLinks = document.querySelectorAll('.nav-link[data-section]');

    navLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            navLinks.forEach(l => l.classList.remove('active'));

            // Add active class to clicked link
            this.classList.add('active');

            // Show corresponding section
            const section = this.getAttribute('data-section');
            showSection(section);
        });
    });
}

function showSection(sectionName) {
    document.querySelectorAll('.content-section').forEach(section => {
        section.style.display = 'none';
    });
    const targetSection = document.getElementById(`${sectionName}-section`);
    if (targetSection) {
        targetSection.style.display = 'block';

        // Load section-specific data
        loadSectionData(sectionName);
    }
}

// Load section-specific data
async function loadSectionData(sectionName) {
    switch (sectionName) {
        case 'dashboard':
            loadDashboardData();
            break;
        case 'import':
            loadImportSection();
            break;
        case 'export':
            loadExportSection();
            break;
        case 'transfer':
            loadTransferSection();
            break;
        case 'adjust':
            if (userRole === 'admin' || userRole === 'super_admin') {
                loadAdjustSection();
            } else {
                showToast('Bạn không có quyền truy cập chức năng này', 'danger');
            }
            break;
        case 'history':
            loadHistorySection();
            break;
        case 'print-barcode':
            loadPrintBarcodeSection();
            break;
        case 'scan-barcode':
            loadScanBarcodeSection();
            break;
        case 'user-management':
            if (userRole === 'super_admin' || userRole === 'admin') {
                loadUserManagementSection();
            }
            break;
        case 'org-chart':
            renderOrganizationChart();
            break;
    }
}

async function loadDashboardData() {
    try {
        // Chạy song song việc lấy dữ liệu để tải trang nhanh hơn
        await Promise.all([
            loadInventorySummary(),
            loadTodayStatistics(),
        ]);

        // Tải bảng tồn kho chính sau các thành phần khác
        await loadInventoryTable();
        initializeDashboardFilters();

        // Sau khi tất cả dữ liệu cơ bản đã tải, bây giờ tải các biểu đồ dựa trên giao dịch
        await Promise.all([
            renderActivityChart(),
            renderTopProductsChart(),
            renderTopAdjustedProductsChart()
        ]);

    } catch (error) {
        console.error('Lỗi tải dữ liệu dashboard:', error);
        showToast('Lỗi tải dữ liệu dashboard', 'danger');
    }
}

async function loadInventorySummary() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'));
        const snapshot = await getDocs(inventoryQuery);

        const uniqueProductCodes = new Set();
        let lowStock = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.status !== 'archived') {
                // Thêm mã hàng vào Set. Các mã trùng lặp sẽ tự động bị bỏ qua.
                if (data.code) {
                    uniqueProductCodes.add(data.code);
                }

                // Logic tồn kho thấp không đổi
                if (data.quantity < 10) {
                    lowStock++;
                }
            }
        });

        document.getElementById('totalProducts').textContent = uniqueProductCodes.size;
        document.getElementById('lowStock').textContent = lowStock;

    } catch (error) {
        console.error('Error loading inventory summary:', error);
    }
}

async function loadTodayStatistics() {
    try {
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        // Load imports
        const importsQuery = query(
            collection(db, 'transactions'),
            where('type', '==', 'import'),
            where('date', '>=', startOfDay)
        );
        const importsSnapshot = await getDocs(importsQuery);
        document.getElementById('todayImports').textContent = importsSnapshot.size;

        // Load exports
        const exportsQuery = query(
            collection(db, 'transactions'),
            where('type', '==', 'export'),
            where('date', '>=', startOfDay)
        );
        const exportsSnapshot = await getDocs(exportsQuery);
        document.getElementById('todayExports').textContent = exportsSnapshot.size;

    } catch (error) {
        console.error('Error loading today statistics:', error);
    }
}

function loadUserManagementSection() {
    if (userRole !== 'super_admin' && userRole !== 'admin') return;
    
    // Khởi tạo listener
    initializeUserManagementListener();
    
    if (!window.userManagementFiltersInitialized) {
        document.getElementById('userNameFilter')?.addEventListener('input', debounce(() => renderUsersTable(1), 500));
        document.getElementById('userRoleFilter')?.addEventListener('change', () => renderUsersTable(1));
        document.getElementById('userStatusFilter')?.addEventListener('change', () => renderUsersTable(1));
        window.userManagementFiltersInitialized = true;
    }
}

function initializeUserManagementListener() {
    if (unsubscribeUsersListener) unsubscribeUsersListener();

    try {
        const usersQuery = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        unsubscribeUsersListener = onSnapshot(usersQuery, (snapshot) => {
            allUsersData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderUsersTable(currentUsersPage);
        });
    } catch (error) {
        console.error("Lỗi lắng nghe danh sách người dùng:", error);
    }
}

function renderUsersTable(page = 1) {
    currentUsersPage = page;
    let filteredUsers = allUsersData;

    // Áp dụng bộ lọc
    const nameFilter = document.getElementById('userNameFilter').value.toLowerCase();
    const roleFilter = document.getElementById('userRoleFilter').value;
    const statusFilter = document.getElementById('userStatusFilter').value;
    if (nameFilter || roleFilter || statusFilter) {
        filteredUsers = allUsersData.filter(user => {
            const nameMatch = !nameFilter || user.name.toLowerCase().includes(nameFilter) || user.email.toLowerCase().includes(nameFilter);
            const roleMatch = !roleFilter || user.role === roleFilter;
            const statusMatch = !statusFilter || user.status === statusFilter;
            return nameMatch && roleMatch && statusMatch;
        });
    }

    const content = document.getElementById('userManagementContent');
    content.innerHTML = '';

        if (filteredUsers.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy dữ liệu phù hợp.</p>';
            return;
        }
        const itemsPerPage = 10; // Hiển thị 10 user mỗi trang
        const totalItems = filteredUsers.length;
        const totalPages = Math.ceil(totalItems / itemsPerPage);
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
        const pageData = filteredUsers.slice(startIndex, endIndex);

        const table = document.createElement('table');
        table.className = 'table table-striped';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Họ tên</th>
                    <th>Email</th>
                    <th>Vai trò</th>
                    <th>Trạng thái</th>
                    <th>Ngày tạo</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        pageData.forEach(user => {
            // Logic tạo hàng (row) giữ nguyên như cũ
            const row = document.createElement('tr');
            if (user.status === 'pending') row.classList.add('table-warning');
            if (user.status === 'rejected') row.classList.add('table-danger', 'bg-opacity-10');

            const statusConfig = {
                'approved': { class: 'bg-success', text: 'Đã duyệt' },
                'pending': { class: 'bg-warning text-dark', text: 'Chờ duyệt' },
                'rejected': { class: 'bg-danger', text: 'Đã từ chối' },
                'disabled': { class: 'bg-secondary', text: 'Vô hiệu hóa' }
            };
            const statusInfo = statusConfig[user.status] || { class: 'bg-dark', text: user.status };

            const roleConfig = {
                'super_admin': { class: 'bg-danger', text: 'Super Admin' },
                'admin': { class: 'bg-primary', text: 'Admin' },
                'staff': { class: 'bg-info text-dark', text: 'Staff' },
                'qc': { class: 'bg-secondary', text: 'QC' },
            };
            const roleInfo = roleConfig[user.role] || { class: 'bg-secondary', text: user.role };
            const createdAt = user.createdAt ? user.createdAt.toDate().toLocaleDateString('vi-VN') : 'N/A';
            let actionButtonsHtml = '';
            const isCurrentUser = currentUser.uid === user.id;

            switch (user.status) {
                case 'pending':
                    actionButtonsHtml = `<button class="btn btn-success btn-sm me-1" onclick="approveUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''} ><i class="fas fa-check"></i> Chấp nhận</button> <button class="btn btn-danger btn-sm" onclick="rejectUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''}><i class="fas fa-times"></i> Từ chối</button>`;
                    break;
                case 'rejected':
                    actionButtonsHtml = `<button class="btn btn-info btn-sm" onclick="restoreUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''}><i class="fas fa-undo"></i> Khôi phục</button>`;
                    break;
                default:
                    let canEdit = false;

                    // Trường hợp 1: Nếu người dùng hiện tại là Super Admin
                    if (userRole === 'super_admin') {
                        // Super Admin có thể sửa tất cả mọi người, trừ chính họ
                        if (!isCurrentUser) {
                            canEdit = true;
                        }
                    }
                    // Trường hợp 2: Nếu người dùng hiện tại là Admin
                    else if (userRole === 'admin') {
                        // Admin chỉ có thể sửa Staff và QC, và không thể sửa chính họ
                        if ((user.role === 'admin' || user.role === 'staff' || user.role === 'qc') && !isCurrentUser) {
                            canEdit = true;
                        }
                    }

                    if (canEdit) {
                        actionButtonsHtml = `<button class="btn btn-warning btn-sm" onclick="showEditUserModal('${user.id}')"><i class="fas fa-edit"></i> Sửa</button>`;
                    } else {
                        // Vẫn giữ nút sửa nhưng vô hiệu hóa nó cho chính người dùng hiện tại
                        if (isCurrentUser) {
                            actionButtonsHtml = `<button class="btn btn-warning btn-sm" disabled title="Bạn không thể tự sửa chính mình"><i class="fas fa-edit"></i> Sửa</button>`;
                        } else {
                            actionButtonsHtml = `<span class="text-muted" title="Bạn không có quyền sửa người dùng này"></span>`;
                        }
                    }
                    break;
            }
            row.innerHTML = `
                <td>${user.name}</td>
                <td>${user.email}</td>
                <td><span class="badge ${roleInfo.class}">${roleInfo.text}</span></td>
                <td><span class="badge ${statusInfo.class}">${statusInfo.text}</span></td>
                <td>${createdAt}</td>
                <td>${actionButtonsHtml}</td>
            `;
            tbody.appendChild(row);
        });

        content.appendChild(table);

        // THÊM MỚI: Gọi hàm tạo thanh phân trang
        updateUserManagementPagination(page, totalPages, totalItems, startIndex, endIndex);
}

async function loadUsersTable(useFilter = false, page = 1) {
    if (userRole !== 'super_admin' && userRole !== 'admin') return;

    try {
        const usersQuery = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(usersQuery);

        let allUsers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        let filteredUsers = allUsers;

        // Lọc dữ liệu (giữ nguyên logic)
        if (useFilter) {
            const nameFilter = document.getElementById('userNameFilter').value.toLowerCase();
            const roleFilter = document.getElementById('userRoleFilter').value;
            const statusFilter = document.getElementById('userStatusFilter').value;

            filteredUsers = allUsers.filter(user => {
                const nameMatch = nameFilter === '' || user.name.toLowerCase().includes(nameFilter) || user.email.toLowerCase().includes(nameFilter);
                const roleMatch = roleFilter === '' || user.role === roleFilter;
                const statusMatch = statusFilter === '' || user.status === statusFilter;
                return nameMatch && roleMatch && statusMatch;
            });
        }

        const content = document.getElementById('userManagementContent');
        content.innerHTML = '';

        if (filteredUsers.length === 0) {
            content.innerHTML = '<p class="text-muted">Không tìm thấy dữ liệu phù hợp.</p>';
            return;
        }
        const itemsPerPage = 10; // Hiển thị 10 user mỗi trang
        const totalItems = filteredUsers.length;
        const totalPages = Math.ceil(totalItems / itemsPerPage);
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
        const pageData = filteredUsers.slice(startIndex, endIndex);

        const table = document.createElement('table');
        table.className = 'table table-striped';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Họ tên</th>
                    <th>Email</th>
                    <th>Vai trò</th>
                    <th>Trạng thái</th>
                    <th>Ngày tạo</th>
                    <th>Thao tác</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        pageData.forEach(user => {
            // Logic tạo hàng (row) giữ nguyên như cũ
            const row = document.createElement('tr');
            if (user.status === 'pending') row.classList.add('table-warning');
            if (user.status === 'rejected') row.classList.add('table-danger', 'bg-opacity-10');

            const statusConfig = {
                'approved': { class: 'bg-success', text: 'Đã duyệt' },
                'pending': { class: 'bg-warning text-dark', text: 'Chờ duyệt' },
                'rejected': { class: 'bg-danger', text: 'Đã từ chối' },
                'disabled': { class: 'bg-secondary', text: 'Vô hiệu hóa' }
            };
            const statusInfo = statusConfig[user.status] || { class: 'bg-dark', text: user.status };

            const roleConfig = {
                'super_admin': { class: 'bg-danger', text: 'Super Admin' },
                'admin': { class: 'bg-primary', text: 'Admin' },
                'staff': { class: 'bg-info text-dark', text: 'Staff' },
                'qc': { class: 'bg-secondary', text: 'QC' },
            };
            const roleInfo = roleConfig[user.role] || { class: 'bg-secondary', text: user.role };
            const createdAt = user.createdAt ? user.createdAt.toDate().toLocaleDateString('vi-VN') : 'N/A';
            let actionButtonsHtml = '';
            const isCurrentUser = currentUser.uid === user.id;

            switch (user.status) {
                case 'pending':
                    actionButtonsHtml = `<button class="btn btn-success btn-sm me-1" onclick="approveUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''} ><i class="fas fa-check"></i> Chấp nhận</button> <button class="btn btn-danger btn-sm" onclick="rejectUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''}><i class="fas fa-times"></i> Từ chối</button>`;
                    break;
                case 'rejected':
                    actionButtonsHtml = `<button class="btn btn-info btn-sm" onclick="restoreUser('${user.id}', '${user.name}')" ${isCurrentUser ? 'disabled' : ''}><i class="fas fa-undo"></i> Khôi phục</button>`;
                    break;
                default:
                    let canEdit = false;

                    // Trường hợp 1: Nếu người dùng hiện tại là Super Admin
                    if (userRole === 'super_admin') {
                        // Super Admin có thể sửa tất cả mọi người, trừ chính họ
                        if (!isCurrentUser) {
                            canEdit = true;
                        }
                    }
                    // Trường hợp 2: Nếu người dùng hiện tại là Admin
                    else if (userRole === 'admin') {
                        // Admin chỉ có thể sửa Staff và QC, và không thể sửa chính họ
                        if ((user.role === 'admin' || user.role === 'staff' || user.role === 'qc') && !isCurrentUser) {
                            canEdit = true;
                        }
                    }

                    if (canEdit) {
                        actionButtonsHtml = `<button class="btn btn-warning btn-sm" onclick="showEditUserModal('${user.id}')"><i class="fas fa-edit"></i> Sửa</button>`;
                    } else {
                        // Vẫn giữ nút sửa nhưng vô hiệu hóa nó cho chính người dùng hiện tại
                        if (isCurrentUser) {
                            actionButtonsHtml = `<button class="btn btn-warning btn-sm" disabled title="Bạn không thể tự sửa chính mình"><i class="fas fa-edit"></i> Sửa</button>`;
                        } else {
                            actionButtonsHtml = `<span class="text-muted" title="Bạn không có quyền sửa người dùng này"></span>`;
                        }
                    }
                    break;
            }
            row.innerHTML = `
                <td>${user.name}</td>
                <td>${user.email}</td>
                <td><span class="badge ${roleInfo.class}">${roleInfo.text}</span></td>
                <td><span class="badge ${statusInfo.class}">${statusInfo.text}</span></td>
                <td>${createdAt}</td>
                <td>${actionButtonsHtml}</td>
            `;
            tbody.appendChild(row);
        });

        content.appendChild(table);

        // THÊM MỚI: Gọi hàm tạo thanh phân trang
        updateUserManagementPagination(page, totalPages, totalItems, startIndex, endIndex);

    } catch (error) {
        console.error('Lỗi tải danh sách người dùng:', error);
        showToast('Lỗi tải danh sách người dùng', 'danger');
    }
}

function updateBadge(badgeId, count) {
    const badgeElement = document.getElementById(badgeId);
    if (!badgeElement) return;

    if (count > 0) {
        badgeElement.textContent = count;
        badgeElement.style.display = 'inline-block';
    } else {
        badgeElement.style.display = 'none';
    }
}

function updateUserManagementPagination(currentPage, totalPages, totalItems, startIndex, endIndex) {
    const container = document.getElementById('userManagementContent');

    let paginationHTML = '';

    // Nút "Trước"
    paginationHTML += `<li class="page-item ${currentPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" onclick="goToUserPage(${currentPage - 1})">Trước</a></li>`;

    // Các nút số trang
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `<li class="page-item ${i === currentPage ? 'active' : ''}"><a class="page-link" href="#" onclick="goToUserPage(${i})">${i}</a></li>`;
    }

    // Nút "Sau"
    paginationHTML += `<li class="page-item ${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}"><a class="page-link" href="#" onclick="goToUserPage(${currentPage + 1})">Sau</a></li>`;

    // Tạo container cho thanh phân trang
    const paginationContainer = document.createElement('div');
    paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
    paginationContainer.innerHTML = `
        <small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${totalItems} kết quả</small>
        <nav aria-label="User management pagination">
            <ul class="pagination pagination-sm mb-0">${paginationHTML}</ul>
        </nav>
    `;

    container.appendChild(paginationContainer);
}

function goToUserPage(page) {
    if (page >= 1) {
        renderUsersTable(page);
    }
}

window.approveUser = async function (userId, userName) {
    const confirmed = await showConfirmation(
        'Xác nhận chấp nhận',
        `Bạn có chắc muốn chấp nhận và kích hoạt tài khoản cho <strong>${userName}</strong>?`,
        'Chấp nhận', 'Hủy', 'success'
    );
    if (!confirmed) return;

    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng!', 'danger');
            return;
        }

        const batch = writeBatch(db);
        batch.update(userDocRef, { status: 'approved' });
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_approval',
            action: 'approved',
            userId: userId,
            userName: userDoc.data().name,
            userEmail: userDoc.data().email,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        showToast(`Đã chấp nhận tài khoản cho ${userName}!`, 'success');
        loadUsersTable();
        updateUserManagementBadge();
    } catch (error) {
        console.error('Error approving user:', error);
        showToast('Lỗi khi chấp nhận người dùng', 'danger');
    }
};

window.rejectUser = async function (userId, userName) {
    const confirmed = await showConfirmation(
        'Xác nhận từ chối',
        `Bạn có chắc muốn từ chối yêu cầu tài khoản của <strong>${userName}</strong>?`,
        'Từ chối', 'Hủy', 'danger'
    );
    if (!confirmed) return;

    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng!', 'danger');
            return;
        }

        const batch = writeBatch(db);
        batch.update(userDocRef, { status: 'rejected' });
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_approval',
            action: 'rejected',
            userId: userId,
            userName: userDoc.data().name,
            userEmail: userDoc.data().email,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        showToast(`Đã từ chối tài khoản của ${userName}.`, 'success');
        loadUsersTable();
        updateUserManagementBadge();
    } catch (error) {
        console.error('Error rejecting user:', error);
        showToast('Lỗi khi từ chối người dùng', 'danger');
    }
};

window.restoreUser = async function (userId, userName) {
    const confirmed = await showConfirmation(
        'Xác nhận khôi phục',
        `Bạn có chắc muốn khôi phục yêu cầu cho <strong>${userName}</strong>? Tài khoản sẽ trở về trạng thái "Chờ duyệt".`,
        'Khôi phục', 'Hủy', 'info'
    );
    if (!confirmed) return;

    try {
        const userDocRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng!', 'danger');
            return;
        }

        const batch = writeBatch(db);
        // Cập nhật trạng thái user
        batch.update(userDocRef, { status: 'pending' });

        // Ghi log giao dịch loại 'user_management' vì đây là hành động chỉnh sửa
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_management',
            userId: userId,
            userName: userDoc.data().name,
            userEmail: userDoc.data().email,
            changes: {
                status: { from: 'rejected', to: 'pending' }
            },
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();
        showToast(`Đã khôi phục yêu cầu cho ${userName}.`, 'success');
        loadUsersTable();
        updateUserManagementBadge();
    } catch (error) {
        console.error('Error restoring user:', error);
        showToast('Lỗi khi khôi phục người dùng', 'danger');
    }
};

window.showEditUserModal = async function (userId) {
     if (userRole !== 'super_admin' && userRole !== 'admin') return;
    try {
        const userDoc = await getDoc(doc(db, 'users', userId));
        if (!userDoc.exists()) {
            showToast('Không tìm thấy người dùng', 'danger');
            return;
        }
        const userData = userDoc.data();
        const modal = createEditUserModal(userId, userData);
        document.body.appendChild(modal);
        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
        modal.addEventListener('hidden.bs.modal', () => modal.remove());
    } catch (error) {
        console.error('Error getting user data for edit:', error);
        showToast('Lỗi lấy dữ liệu người dùng', 'danger');
    }
};

function createEditUserModal(userId, userData) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editUserModal';
    modal.setAttribute('tabindex', '-1');

    const roles = [
        { value: 'staff', label: 'Staff', color: 'info', icon: 'fas fa-user' },
        { value: 'qc', label: 'QC', color: 'secondary', icon: 'fas fa-clipboard-check' },
        { value: 'admin', label: 'Admin', color: 'primary', icon: 'fas fa-user-tie' },
        { value: 'super_admin', label: 'Super Admin', color: 'danger', icon: 'fas fa-user-shield' }
    ];

    const statuses = [
        { value: 'pending', label: 'Chờ duyệt', color: 'warning', icon: 'fas fa-clock' },
        { value: 'approved', label: 'Đã phê duyệt', color: 'success', icon: 'fas fa-check-circle' },
        { value: 'rejected', label: 'Từ chối', color: 'danger', icon: 'fas fa-times-circle' },
        { value: 'disabled', label: 'Vô hiệu hóa', color: 'secondary', icon: 'fas fa-ban' }
    ];

    // --- BẮT ĐẦU THAY ĐỔI LOGIC ---
    let roleAndStatusHtml = '';
    // Chỉ tạo HTML cho phần này nếu người dùng là Super Admin
    if (userRole === 'super_admin') {
        const roleOptions = roles.map(role => `<div class="role-compact ${userData.role === role.value ? 'selected' : ''}" data-value="${role.value}"><i class="${role.icon} text-${role.color}"></i><span class="badge bg-${role.color}">${role.label}</span><i class="fas fa-check-circle text-success check-icon" style="display: ${userData.role === role.value ? 'inline' : 'none'}"></i></div>`).join('');
        const statusOptions = statuses.map(status => `<div class="status-compact ${userData.status === status.value ? 'selected' : ''}" data-value="${status.value}"><i class="${status.icon} text-${status.color}"></i><span class="badge bg-${status.color}">${status.label}</span><i class="fas fa-check-circle text-success check-icon" style="display: ${userData.status === status.value ? 'inline' : 'none'}"></i></div>`).join('');

        roleAndStatusHtml = `
            <hr>
            <div class="mb-3">
                <label class="form-label fw-bold"><i class="fas fa-user-tag text-primary me-1"></i>Vai trò</label>
                <div class="role-selector-compact">${roleOptions}</div>
                <input type="hidden" id="selectedRole" value="${userData.role}">
            </div>
            <div class="mb-3">
                <label class="form-label fw-bold"><i class="fas fa-toggle-on text-primary me-1"></i>Trạng thái</label>
                <div class="status-selector-compact">${statusOptions}</div>
                <input type="hidden" id="selectedStatus" value="${userData.status}">
            </div>
        `;
    } else {
        // Nếu không phải Super Admin, vẫn cần có các thẻ input ẩn để hàm save không bị lỗi
        roleAndStatusHtml = `
            <input type="hidden" id="selectedRole" value="${userData.role}">
            <input type="hidden" id="selectedStatus" value="${userData.status}">
        `;
    }
    // --- KẾT THÚC THAY ĐỔI LOGIC ---

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white"><h5 class="modal-title"><i class="fas fa-user-edit"></i> Chỉnh sửa người dùng</h5><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
                <div class="modal-body">
                    <form id="editUserForm">
                        <div class="row mb-3">
                            <div class="col-md-6"><label class="form-label fw-bold"><i class="fas fa-user text-primary me-1"></i>Họ và tên</label><input type="text" class="form-control" id="editUserName" value="${userData.name}" required></div>
                            <div class="col-md-6"><label class="form-label fw-bold"><i class="fas fa-envelope text-primary me-1"></i>Email</label><input type="email" class="form-control" value="${userData.email}" readonly><small class="text-muted">Không thể thay đổi</small></div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-6"><label class="form-label fw-bold"><i class="fas fa-briefcase text-primary me-1"></i>Chức vụ</label><input type="text" class="form-control" id="editUserPosition" value="${userData.position || ''}"></div>
                            <div class="col-md-6"><label class="form-label fw-bold"><i class="fas fa-building text-primary me-1"></i>Bộ phận</label><input type="text" class="form-control" id="editUserDepartment" value="${userData.department || ''}"></div>
                        </div>
                        <div class="row mb-3">
                            <div class="col-md-6"><label class="form-label fw-bold"><i class="fas fa-phone text-primary me-1"></i>Số điện thoại</label><input type="text" class="form-control" id="editUserPhone" value="${userData.phone || ''}"></div>
                            <div class="col-md-6">
                                <label class="form-label fw-bold"><i class="fas fa-user-shield text-primary me-1"></i>Quản lý trực tiếp</label>
                                <div class="w-100">
                                    <div class="autocomplete-container-compact"><input type="text" class="form-control" id="editUserManager" value="${userData.manager || ''}" placeholder="Tìm theo tên hoặc email..."><div class="suggestion-dropdown-compact" id="editUserManagerSuggestions" style="display: none;"></div></div>
                                    <div class="form-check highest-authority-toggle"><input class="form-check-input" type="checkbox" id="editUserIsHighest" ${userData.isHighestAuthority ? 'checked' : ''}><label class="form-check-label" for="editUserIsHighest">Đặt làm quyền cao nhất</label></div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Sử dụng biến đã được xử lý ở trên -->
                        ${roleAndStatusHtml}

                    </form>
                </div>
                <div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal"><i class="fas fa-times me-1"></i> Hủy</button><button type="button" class="btn btn-primary" onclick="saveUserChanges('${userId}')"><i class="fas fa-save me-1"></i> Lưu thay đổi</button></div>
            </div>
        </div>
    `;

    setTimeout(() => {
        // Chỉ chạy hàm này nếu các lựa chọn vai trò/trạng thái được hiển thị
        if (userRole === 'super_admin') {
            setupCompactUserModalEventListeners();
        }
        
        const managerInput = modal.querySelector('#editUserManager');
        managerInput.addEventListener('input', (e) => handleManagerSearch(e, 'editUser', userId));
        managerInput.addEventListener('blur', () => setTimeout(() => hideSuggestions('editUserManagerSuggestions'), 200));
        
        modal.querySelector('#editUserIsHighest').addEventListener('change', () => handleHighestAuthorityToggle('editUser'));
        handleHighestAuthorityToggle('editUser');
    }, 0);

    return modal;
}

function handleManagerSearch(event, prefix, excludeUid) {
    const searchTerm = event.target.value.toLowerCase();
    const suggestionsContainer = document.getElementById(`${prefix}ManagerSuggestions`);

    if (searchTerm.length < 2) {
        suggestionsContainer.style.display = 'none';
        return;
    }

    const filteredUsers = allUsersCache.filter(user =>
        user.uid !== excludeUid && // Loại bỏ chính user hiện tại
        !user.isHighestAuthority && // THÊM MỚI: Loại bỏ người có quyền cao nhất
        (user.name.toLowerCase().includes(searchTerm) || user.email.toLowerCase().includes(searchTerm))
    );


    if (filteredUsers.length === 0) {
        suggestionsContainer.style.display = 'none';
        return;
    }

    suggestionsContainer.innerHTML = filteredUsers
        .slice(0, 5) // Giới hạn 5 kết quả
        .map(user => {
            // Tạo chuỗi HTML cho chức vụ, chỉ hiển thị nếu người dùng có chức vụ
            const positionHtml = user.position ? ` <span class="text-muted">(${user.position})</span>` : '';

            // Ghép chuỗi HTML hoàn chỉnh
            return `<div class="suggestion-item-compact" onclick="window.selectManager('${prefix}', '${user.name.replace(/'/g, "\\'")}')">
                    <strong>${user.name}</strong>${positionHtml} - <small>${user.email}</small>
                </div>`;
        }).join('');
    suggestionsContainer.style.display = 'block';
}

window.selectManager = function (prefix, name) {
    document.getElementById(`${prefix}Manager`).value = name;
    document.getElementById(`${prefix}ManagerSuggestions`).style.display = 'none';
}

function updateCompactStatusPreview() {
    const selectedRole = document.getElementById('selectedRole')?.value;
    const selectedStatus = document.getElementById('selectedStatus')?.value;
    const preview = document.getElementById('currentStatusPreview');

    if (!preview) return;

    const roleLabels = {
        'staff': 'Staff',
        'admin': 'Admin',
        'super_admin': 'Super Admin',
        'qc': 'QC'
    };

    const statusLabels = {
        'pending': 'Chờ duyệt',
        'approved': 'Đã phê duyệt',
        'rejected': 'Từ chối',
        'disabled': 'Vô hiệu hóa'
    };

    preview.innerHTML = `Hiện tại: ${roleLabels[selectedRole]} - ${statusLabels[selectedStatus]}`;
}

function setupCompactUserModalEventListeners() {
    // Role selection
    document.querySelectorAll('.role-compact').forEach(option => {
        option.addEventListener('click', function () {
            document.querySelectorAll('.role-compact').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.check-icon').style.display = 'none';
            });

            this.classList.add('selected');
            this.querySelector('.check-icon').style.display = 'inline';
            document.getElementById('selectedRole').value = this.dataset.value;
            updateCompactStatusPreview();
        });
    });

    // Status selection
    document.querySelectorAll('.status-compact').forEach(option => {
        option.addEventListener('click', function () {
            document.querySelectorAll('.status-compact').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.check-icon').style.display = 'none';
            });

            this.classList.add('selected');
            this.querySelector('.check-icon').style.display = 'inline';
            document.getElementById('selectedStatus').value = this.dataset.value;
            updateCompactStatusPreview();
        });
    });
}

function updateCurrentStatusDisplay() {
    const selectedRole = document.getElementById('selectedRole')?.value;
    const selectedStatus = document.getElementById('selectedStatus')?.value;
    const display = document.getElementById('currentStatusDisplay');

    if (!display) return;

    const roleConfig = {
        'staff': { color: 'info', icon: 'fas fa-user', label: 'Staff' },
        'admin': { color: 'primary', icon: 'fas fa-user-tie', label: 'Admin' },
        'super_admin': { color: 'danger', icon: 'fas fa-user-shield', label: 'Super Admin' },
        'qc': { color: 'secondary', icon: 'fas fa-clipboard-check', label: 'QC' },
    };

    const statusConfig = {
        'pending': { color: 'warning', icon: 'fas fa-clock', label: 'Chờ duyệt' },
        'approved': { color: 'success', icon: 'fas fa-check-circle', label: 'Đã phê duyệt' },
        'rejected': { color: 'danger', icon: 'fas fa-times-circle', label: 'Từ chối' },
        'disabled': { color: 'secondary', icon: 'fas fa-ban', label: 'Vô hiệu hóa' }
    };

    const role = roleConfig[selectedRole] || { color: 'secondary', icon: 'fas fa-user', label: selectedRole };
    const status = statusConfig[selectedStatus] || { color: 'secondary', icon: 'fas fa-question', label: selectedStatus };

    display.innerHTML = `
        <span class="badge bg-${role.color} me-2">
            <i class="${role.icon} me-1"></i>${role.label}
        </span>
        <span class="badge bg-${status.color}">
            <i class="${status.icon} me-1"></i>${status.label}
        </span>
    `;
}

function setupUserModalEventListeners() {
    // Role selection
    document.querySelectorAll('.role-option').forEach(option => {
        option.addEventListener('click', function () {
            // Remove selected class from all options
            document.querySelectorAll('.role-option').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.role-check i').style.display = 'none';
            });

            // Add selected class to clicked option
            this.classList.add('selected');
            this.querySelector('.role-check i').style.display = 'block';

            // Update hidden input
            document.getElementById('selectedRole').value = this.dataset.value;
            updateCurrentStatusDisplay();
        });
    });

    // Status selection
    document.querySelectorAll('.status-option').forEach(option => {
        option.addEventListener('click', function () {
            // Remove selected class from all options
            document.querySelectorAll('.status-option').forEach(opt => {
                opt.classList.remove('selected');
                opt.querySelector('.status-check i').style.display = 'none';
            });

            // Add selected class to clicked option
            this.classList.add('selected');
            this.querySelector('.status-check i').style.display = 'block';

            // Update hidden input
            document.getElementById('selectedStatus').value = this.dataset.value;
            updateCurrentStatusDisplay();
        });
    });
}

window.saveUserChanges = async function (userId) {
    const currentUserRole = userRole; 
    if (currentUserRole !== 'super_admin' && currentUserRole !== 'admin') return;

    try {
        const originalUserDoc = await getDoc(doc(db, 'users', userId));
        if (!originalUserDoc.exists()) {
            showToast('Không tìm thấy người dùng để cập nhật.', 'danger');
            return;
        }
        const originalUserData = originalUserDoc.data();

        // --- BẮT ĐẦU SỬA LỖI ---
        let isHighest = originalUserData.isHighestAuthority || false; // Mặc định lấy giá trị cũ
        const isHighestCheckbox = document.getElementById('editUserIsHighest');
        // Chỉ đọc giá trị từ checkbox nếu người dùng là Super Admin (vì chỉ họ mới thấy checkbox này)
        if (currentUserRole === 'super_admin' && isHighestCheckbox) {
            isHighest = isHighestCheckbox.checked;
        }
        // --- KẾT THÚC SỬA LỖI ---

        const newName = document.getElementById('editUserName').value.trim();
        const newPosition = document.getElementById('editUserPosition').value.trim();
        const newDepartment = document.getElementById('editUserDepartment').value.trim();
        const newPhone = document.getElementById('editUserPhone').value.trim();
        const newManager = isHighest ? '' : document.getElementById('editUserManager').value.trim();

        if (!newName) { showToast('Vui lòng nhập họ tên', 'warning'); return; }

        const updateData = {
            name: newName,
            position: newPosition,
            department: newDepartment,
            phone: newPhone,
            manager: newManager,
            isHighestAuthority: isHighest,
        };
        
        if (currentUserRole === 'super_admin') {
            updateData.role = document.getElementById('selectedRole').value;
            updateData.status = document.getElementById('selectedStatus').value;
        }

        const confirmed = await showConfirmation('Xác nhận cập nhật', 'Bạn có chắc muốn thực hiện các thay đổi?', 'Cập nhật', 'Hủy', 'question');
        if (!confirmed) return;

        const batch = writeBatch(db);

        if (currentUserRole === 'super_admin' && isHighest) {
            const oldHighest = allUsersCache.find(u => u.isHighestAuthority && u.uid !== userId);
            if (oldHighest) {
                batch.update(doc(db, 'users', oldHighest.uid), { isHighestAuthority: false });
            }
        }
        
        batch.update(doc(db, 'users', userId), updateData);
        
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_management', userId: userId, userName: newName,
            userEmail: originalUserData.email, changes: { /* Logic so sánh thay đổi */ },
            performedBy: currentUser.uid, performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });
        
        await batch.commit();

        showToast('Cập nhật người dùng thành công!', 'success');
        
        await fetchAllUsersForCache(true);
        if (document.getElementById('org-chart-section').style.display === 'block') {
            renderOrganizationChart();
        }

        bootstrap.Modal.getInstance(document.getElementById('editUserModal')).hide();
        loadUsersTable();
        updateUserManagementBadge();

    } catch (error) {
        console.error('Error saving user changes:', error);
        showToast('Lỗi khi lưu thay đổi', 'danger');
    }
}

async function loadInventoryTable(useFilter = false, page = 1) {
     if (unsubscribeInventory) {
        unsubscribeInventory();
    }
    try {
        const inventoryQuery = query(collection(db, 'inventory'), orderBy('code'));

        // Bắt đầu lắng nghe thời gian thực
        unsubscribeInventory = onSnapshot(inventoryQuery, (snapshot) => {
            allDashboardData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            // Yêu cầu vẽ lại các biểu đồ với dữ liệu mới nhất
            requestAnimationFrame(() => {
                renderAisleItemCountChart(allDashboardData);
                renderInventoryStatusChart(allDashboardData);
                renderCategoryOverviewChart(allDashboardData);
            });

            // Sau khi có dữ liệu mới, áp dụng bộ lọc và hiển thị
            filterAndDisplayInventory(page);
        }, (error) => {
            console.error("Lỗi lắng nghe bảng tồn kho:", error);
            showToast("Lỗi kết nối thời gian thực đến dữ liệu tồn kho.", 'danger');
        });

    } catch (error) {
        console.error('Lỗi thiết lập lắng nghe tồn kho:', error);
    }
}

function filterAndDisplayInventory(page = 1) {
    // Logic lọc không đổi
    const codeFilter = document.getElementById('dashboardCodeFilter')?.value.toLowerCase();
    const categoryFilter = document.getElementById('dashboardCategoryFilter')?.value;
    const stockFilter = document.getElementById('dashboardStockFilter')?.value;

    let activeData = allDashboardData.filter(item => item.status !== 'archived');

    if (codeFilter || categoryFilter || stockFilter) {
        activeData = activeData.filter(data => {
            let match = true;
            if (codeFilter && !data.code?.toLowerCase().includes(codeFilter)) match = false;
            if (categoryFilter && data.category !== categoryFilter) match = false;
            if (stockFilter) {
                const quantity = parseInt(data.quantity);
                if (stockFilter === 'low' && quantity >= 10) match = false;
                if (stockFilter === 'normal' && quantity < 10) match = false;
                if (stockFilter === 'zero' && quantity !== 0) match = false;
            }
            return match;
        });
    }
    
    filteredDashboardData = activeData;
    currentDashboardPage = page;
    const totalItems = filteredDashboardData.length;
    const totalPages = Math.ceil(totalItems / dashboardItemsPerPage);
    const startIndex = (page - 1) * dashboardItemsPerPage;
    const endIndex = Math.min(startIndex, totalItems - 1) + dashboardItemsPerPage;
    const pageData = filteredDashboardData.slice(startIndex, endIndex);

    const contentContainer = document.getElementById('inventoryContent');
    if (!contentContainer) {
            console.error("Dashboard inventory content container not found!");
            return;
        }
        contentContainer.innerHTML = '';

        if (totalItems === 0) {
            contentContainer.innerHTML = '<p class="text-muted">Không tìm thấy dữ liệu phù hợp.</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'table table-striped';

        let headerHTML = `
            <thead>
                <tr class="text-center">
                    <th>Mã hàng</th>
                    <th>Tên mô tả</th>
                    <th>Đơn vị tính</th>
                    <th>Số lượng</th>
                    <th>Danh mục</th>
                    <th>Vị trí</th>
        `;
        if (userRole === 'super_admin') {
            headerHTML += '<th>Thao tác</th>';
        }
        headerHTML += '</tr></thead>';

        let bodyHTML = '<tbody>';
       pageData.forEach(doc => {
            // === BẮT ĐẦU THAY ĐỔI LOGIC TÔ MÀU DÒNG ===
            let rowClass = '';
            const quantity = parseInt(doc.quantity);
            if (quantity === 0) {
                rowClass = 'class="table-danger"'; // Hết hàng
            } else if (quantity < 10) {
                rowClass = 'class="table-warning"'; // Tồn kho thấp
            }

            let rowHTML = `<tr ${rowClass}>
                <td class="text-center">${doc.code}</td>
                <td class="text-center">${doc.name}</td>
                <td class="text-center">${doc.unit}</td>
                <td class="text-center">${doc.quantity}</td>
                <td class="text-center">${doc.category}</td>
                <td class="text-center">${doc.location}</td>
            `;

            if (userRole === 'super_admin') {
                const docDataString = JSON.stringify(doc).replace(/'/g, "\\'");
                rowHTML += `
                    <td class="text-center">
                        <button class="btn btn-warning btn-sm me-1" onclick='editInventoryItem(${docDataString})'>
                            <i class="fas fa-edit"></i> Sửa
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="deleteInventoryItem('${doc.id}', '${doc.code}', ${doc.quantity})">
                            <i class="fas fa-trash"></i> Xóa
                        </button>
                    </td>
                `;
            }
            rowHTML += '</tr>';
            bodyHTML += rowHTML;
        });
        bodyHTML += '</tbody>';

        table.innerHTML = headerHTML + bodyHTML;

        const paginationContainer = document.createElement('div');
        paginationContainer.className = 'd-flex justify-content-between align-items-center mt-3';
        const paginationInfo = `<small class="text-muted">Hiển thị ${startIndex + 1} - ${endIndex} của ${totalItems} kết quả</small>`;
        let paginationLinks = '';
        paginationLinks += `<li class="page-item ${page === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${page - 1}">Trước</a></li>`;
        const maxVisiblePages = 5;
        let startPage = Math.max(1, page - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }
        for (let i = startPage; i <= endPage; i++) {
            paginationLinks += `<li class="page-item ${i === page ? 'active' : ''}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
        }

        paginationLinks += `<li class="page-item ${page === totalPages || totalPages === 0 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${page + 1}">Sau</a></li>`;

        const paginationNav = `
            <nav aria-label="Dashboard pagination">
                <ul class="pagination pagination-sm mb-0">${paginationLinks}</ul>
            </nav>
        `;

        paginationContainer.innerHTML = paginationInfo + paginationNav;
        const tableResponsiveDiv = document.createElement('div');
        tableResponsiveDiv.className = 'table-responsive';
        tableResponsiveDiv.appendChild(table);
        contentContainer.appendChild(tableResponsiveDiv);
        contentContainer.appendChild(paginationContainer);
        const links = paginationContainer.querySelectorAll('.page-link[data-page]');
        links.forEach(link => {
            link.addEventListener('click', function (e) {
                e.preventDefault();
                const pageNum = parseInt(this.dataset.page);
                if (pageNum >= 1 && !this.parentElement.classList.contains('disabled')) {
                    loadInventoryTable(true, pageNum);
                }
            });
        });
}       

function initializeSidebarToggle() {
    const toggleButton = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebarMenu');
    const overlay = document.getElementById('sidebarOverlay');

    // Nếu các phần tử không tồn tại thì không làm gì cả
    if (!toggleButton || !sidebar || !overlay) {
        return;
    }

    // Hàm để đóng sidebar
    const closeSidebar = () => {
        sidebar.classList.remove('show');
        overlay.classList.remove('show');
    };

    // Sự kiện khi nhấn nút Menu: Mở sidebar
    toggleButton.addEventListener('click', () => {
        sidebar.classList.add('show');
        overlay.classList.add('show');
    });

    // Sự kiện khi nhấn vào lớp phủ: Đóng sidebar
    overlay.addEventListener('click', closeSidebar);

    // Sự kiện khi nhấn vào một liên kết trong sidebar: Đóng sidebar
    sidebar.addEventListener('click', (event) => {
        // Chỉ đóng nếu mục được nhấn là một liên kết điều hướng
        const navLink = event.target.closest('.nav-link');

        if (navLink) {
            // Các liên kết mở menu con như "Barcode" không có thuộc tính này.
            if (navLink.hasAttribute('data-section')) {
                closeSidebar();
            }
        }
    });
}

async function updateUserManagementBadge() {
    if (userRole !== 'super_admin' && userRole !== 'admin') return;
    try {
        const pendingQuery = query(collection(db, 'users'), where('status', '==', 'pending'));
        const snapshot = await getDocs(pendingQuery);
        const count = snapshot.size;

        // FIX 1: Thêm kiểm tra null cho badge
        const badgeElement = document.getElementById('userCountBadge');
        if (badgeElement) {
            badgeElement.textContent = count;
            badgeElement.style.display = count > 0 ? 'inline-block' : 'none';
        }
    } catch (error) {
        console.error('Error updating user management badge:', error);
    }
}

function saveSettings() {
    localStorage.setItem(`userSettings_${currentUser.uid}`, JSON.stringify(userSettings));
    localStorage.setItem('app_theme', userSettings.theme);
}

function applySettings() {
    // Theme (dark/light)
    document.documentElement.setAttribute('data-theme', userSettings.theme || 'light');
    document.getElementById('darkModeSwitch').checked = (userSettings.theme === 'dark');

    // Primary Color
    const primaryColor = userSettings.primaryColor || '#007bff';
    document.documentElement.style.setProperty('--primary-color', primaryColor);
    // Cập nhật màu active cho color picker
    document.querySelectorAll('.color-box').forEach(box => {
        box.classList.remove('active');
        if (box.dataset.color === primaryColor) {
            box.classList.add('active');
        }
    });

    // Dashboard Widgets
    const showWidgets = userSettings.showStatsWidgets !== false; // Mặc định là true
    const statsRow = document.querySelector('#dashboard-section .row:first-child');
    if (statsRow) {
        statsRow.style.display = showWidgets ? '' : 'none';
    }
    document.getElementById('toggleStatsWidgetsSwitch').checked = showWidgets;
}

function renderAisleItemCountChart(inventoryData) {
    try {
        const ctx = document.getElementById('aisleItemCountChart')?.getContext('2d');
        if (!ctx) return;
        if (aisleItemCountChartInstance) {
            aisleItemCountChartInstance.destroy();
        }
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        // Hiển thị một thông báo "Đang tải..." cho người dùng thấy.
        ctx.font = "16px sans-serif";
        ctx.fillStyle = "#6c757d";
        ctx.textAlign = "center";
        ctx.fillText('Đang tải dữ liệu biểu đồ...', ctx.canvas.width / 2, ctx.canvas.height / 2);

        // <<== BƯỚC 2: XỬ LÝ DỮ LIỆU (Giữ nguyên) ==>>
        if (!inventoryData || inventoryData.length === 0) return;
        const aisleData = {};
        inventoryData.forEach(item => {
            const location = item.location || '';
            const itemCode = item.code;
            const aisleMatch = location.trim().match(/^[A-Z]/i);
            if (aisleMatch && itemCode) {
                const aisle = `Dãy ${aisleMatch[0].toUpperCase()}`;
                if (!aisleData[aisle]) aisleData[aisle] = new Set();
                aisleData[aisle].add(itemCode);
            }
        });
        const sortedAisles = Object.keys(aisleData).sort();
        const labels = sortedAisles;
        const data = sortedAisles.map(aisle => aisleData[aisle].size);

        if (data.length === 0) return;
        aisleItemCountChartInstance = new Chart(ctx, {
            type: 'doughnut',
            plugins: [ChartDataLabels], // Đăng ký plugin tại đây
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: ['#4e73df', '#1cc88a', '#36b9cc', '#f6c23e', '#e74a3b', '#858796'],
                    borderColor: '#ffffff',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right' },
                    datalabels: {
                        formatter: (value) => value > 0 ? value : '',
                        color: '#fff',
                        font: { weight: 'bold', size: 14 }
                    }
                },
                animation: {
                    animateRotate: true,
                    //animateScale: true,
                    duration: 2000,
                    easing: 'easeOutQuart'
                }
            }
        });

    } catch (error) {
        console.error('Lỗi khi vẽ biểu đồ theo dãy:', error);
    }
}

function renderCategoryOverviewChart(inventoryData) {
    try {
        if (!inventoryData) return;
        Chart.register(ChartDataLabels);
        const categoryQuantities = {};
        inventoryData.forEach(item => {
            const category = item.category || 'Không xác định';
            const quantity = item.quantity || 0;
            categoryQuantities[category] = (categoryQuantities[category] || 0) + quantity;
        });

        const labels = Object.keys(categoryQuantities);
        const data = Object.values(categoryQuantities);
        const ctx = document.getElementById('categoryOverviewChart')?.getContext('2d');
        if (!ctx) return;
        if (categoryOverviewChartInstance) categoryOverviewChartInstance.destroy();

        categoryOverviewChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: ['#4e73df', '#1cc88a', '#36b9cc', '#f6c23e', '#e74a3b', '#858796'],
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right' },
                    datalabels: {
                        formatter: (value) => value > 0 ? value.toLocaleString('vi-VN') : '',
                        color: '#fff', font: { weight: 'bold' }
                    }
                },
                animation: { animateRotate: true, animateScale: true, duration: 800 }
            }
        });
    } catch (error) {
        console.error("Lỗi vẽ biểu đồ tổng quan danh mục:", error);
    }
}

async function renderTopAdjustedProductsChart() {
    try {
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const transQuery = query(collection(db, 'transactions'),
            where('type', '==', 'adjust'),
            where('timestamp', '>=', sixMonthsAgo)
        );
        const snapshot = await getDocs(transQuery);
        const adjustments = {}; // { 'SP001': { name: 'Sản phẩm A', totalAdjustment: 55 }, ... }
        snapshot.forEach(transDoc => {
            const transaction = transDoc.data();
            transaction.items?.forEach(item => {
                const magnitude = Math.abs(item.adjustment || 0);
                if (!adjustments[item.itemCode]) {
                    adjustments[item.itemCode] = { name: item.itemName, totalAdjustment: 0 };
                }
                adjustments[item.itemCode].totalAdjustment += magnitude;
            });
        });

        const sortedProducts = Object.entries(adjustments)
            .sort(([, a], [, b]) => b.totalAdjustment - a.totalAdjustment)
            .slice(0, 5);

        const labels = sortedProducts.map(([code, data]) => `${code}`);
        const data = sortedProducts.map(([, data]) => data.totalAdjustment);
        const ctx = document.getElementById('topAdjustedProductsChart')?.getContext('2d');
        if (!ctx) return;
        if (topAdjustedProductsChartInstance) topAdjustedProductsChartInstance.destroy();

        topAdjustedProductsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Tổng lượng chỉnh số',
                    data: data,
                    backgroundColor: 'rgba(231, 74, 59, 0.7)', // Màu đỏ
                    borderColor: 'rgba(231, 74, 59, 1)',
                    borderWidth: 1,
                    borderRadius: 5,
                }]
            },
            options: {
                indexAxis: 'y', // Biểu đồ cột ngang
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false } // Ẩn chú thích vì chỉ có 1 bộ dữ liệu
                },
                scales: {
                    x: { beginAtZero: true, ticks: { precision: 0 } }
                }
            }
        });
    } catch (error) {
        console.error("Lỗi vẽ biểu đồ top chỉnh số:", error);
    }
}

async function renderInventoryStatusChart(inventoryData) { // <-- THAY ĐỔI Ở ĐÂY
    try {
        let lowStock = 0, normalStock = 0, outOfStock = 0;
        inventoryData.forEach(item => {
            const qty = item.quantity || 0;
            if (qty === 0) outOfStock++;
            else if (qty < 10) lowStock++;
            else normalStock++;
        });

        const ctx = document.getElementById('inventoryStatusChart')?.getContext('2d');
        if (!ctx) return;

        if (inventoryStatusChartInstance) {
            inventoryStatusChartInstance.destroy();
        }

        if (normalStock === 0 && lowStock === 0 && outOfStock === 0) {
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.textAlign = 'center';
            ctx.fillStyle = '#6c757d';
            ctx.fillText('Không có dữ liệu tồn kho.', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        inventoryStatusChartInstance = new Chart(ctx, {
            type: 'pie',
            plugins: [ChartDataLabels],
            data: {
                labels: ['Tồn kho An toàn', 'Tồn kho Thấp', 'Hết hàng'],
                datasets: [{
                    data: [normalStock, lowStock, outOfStock],
                    backgroundColor: ['#1cc88a', '#f6c23e', '#e74a3b'],
                    borderColor: '#ffffff',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right', // 1. Di chuyển hộp chú thích sang phải
                        align: 'center',   // 2. Căn giữa các mục chú thích theo chiều dọc
                        labels: {
                            boxWidth: 20, // Giảm kích thước ô màu cho gọn
                            padding: 15   // Tăng khoảng cách giữa các mục
                        }
                    },
                    datalabels: {
                        formatter: (value) => value > 0 ? value : '',
                        color: '#fff', font: { weight: 'bold', size: 12 }
                    }
                },
                animation: {
                    animateRotate: true,
                    duration: 2000,
                    easing: 'easeOutBounce'
                }
            }
        });
    } catch (error) {
        console.error("Lỗi vẽ biểu đồ tình trạng tồn kho:", error);
    }
}

async function renderTopProductsChart() {
    try {
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        const transQuery = query(collection(db, 'transactions'),
            where('type', 'in', ['import', 'export']),
            where('timestamp', '>=', ninetyDaysAgo)
        );
        const snapshot = await getDocs(transQuery);
        const productCounts = {}; // { 'SP001': { import: 50, export: 30, name: 'Sản phẩm A' }, ... }

        snapshot.forEach(doc => {
            const transaction = doc.data();
            transaction.items?.forEach(item => {
                if (!productCounts[item.code]) {
                    productCounts[item.code] = { import: 0, export: 0, name: item.name };
                }
                if (transaction.type === 'import') {
                    productCounts[item.code].import += item.quantity;
                } else {
                    productCounts[item.code].export += item.quantity;
                }
            });
        });

        const sortedProducts = Object.entries(productCounts)
            .sort(([, a], [, b]) => (b.import + b.export) - (a.import + a.export))
            .slice(0, 5);

        const labels = sortedProducts.map(([code, data]) => `${code}`);
        const importData = sortedProducts.map(([, data]) => data.import);
        const exportData = sortedProducts.map(([, data]) => -data.export); // Sử dụng số âm để vẽ sang trái
        const ctx = document.getElementById('topProductsChart')?.getContext('2d');
        if (!ctx) return;
        if (topProductsChartInstance) topProductsChartInstance.destroy();

        topProductsChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Nhập', data: importData, backgroundColor: 'rgba(75, 192, 192, 0.7)' },
                    { label: 'Xuất', data: exportData, backgroundColor: 'rgba(255, 159, 64, 0.7)' }
                ]
            },
            options: {
                indexAxis: 'y', // Đây là chìa khóa để tạo biểu đồ cột ngang
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, ticks: { callback: value => Math.abs(value) } }, // Hiển thị số dương
                    y: { stacked: true }
                },
                plugins: {
                    tooltip: { callbacks: { label: c => `${c.dataset.label}: ${Math.abs(c.raw)}` } }
                },
                animation: {
                    duration: 1000,
                    delay: (context) => {
                        let delay = 0;
                        if (context.type === 'data' && context.mode === 'default') {
                            // Mỗi cột sẽ xuất hiện sau cột trước đó 100ms
                            delay = context.dataIndex * 200;
                        }
                        return delay;
                    },
                }
            }
        });
    } catch (error) {
        console.error("Lỗi vẽ biểu đồ top sản phẩm:", error);
    }
}

async function renderActivityChart() {
    try {
        Chart.register(ChartDataLabels);
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const transactionsQuery = query(
            collection(db, 'transactions'),
            where('type', 'in', ['import', 'export']),
            where('timestamp', '>=', sixMonthsAgo)
        );

        const snapshot = await getDocs(transactionsQuery);
        const monthlyData = {};
        const monthLabels = [];

        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const monthLabel = `Tháng ${d.getMonth() + 1}/${d.getFullYear()}`;
            monthLabels.push(monthLabel);
            monthlyData[monthKey] = { imports: 0, exports: 0 };
        }

        snapshot.forEach(doc => {
            const transaction = doc.data();
            if (!transaction.timestamp) return;
            const date = transaction.timestamp.toDate();
            const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            if (monthlyData[monthKey]) {
                if (transaction.type === 'import') {
                    monthlyData[monthKey].imports += (transaction.items?.length || 0);
                } else if (transaction.type === 'export') {
                    monthlyData[monthKey].exports += (transaction.items?.length || 0);
                }
            }
        });

        const importCounts = Object.values(monthlyData).map(d => d.imports);
        const exportCounts = Object.values(monthlyData).map(d => d.exports);
        const ctx = document.getElementById('activityChart')?.getContext('2d');
        if (!ctx) return;

        if (activityChartInstance) {
            activityChartInstance.destroy();
        }

        activityChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: monthLabels,
                datasets: [
                    {
                        label: 'Số mã hàng Nhập',
                        data: importCounts,
                        backgroundColor: 'rgba(75, 192, 192, 0.7)',
                    },
                    {
                        label: 'Số mã hàng Xuất',
                        data: exportCounts,
                        backgroundColor: 'rgba(255, 159, 64, 0.7)',
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { precision: 0 }
                    }
                },
                plugins: {
                    datalabels: {
                        anchor: 'center', // Hiển thị nhãn ở trên đỉnh của cột
                        align: 'end',   // Căn lề nhãn ở trên đỉnh
                        formatter: (value, context) => {
                            // Chỉ hiển thị nhãn nếu giá trị lớn hơn 0
                            return value > 0 ? value : '';
                        },
                        color: '#555', // Màu chữ cho nhãn
                        font: {
                            weight: 'bold'
                        }
                    }
                },
                animation: {
                    duration: 800,
                    // Hàm delay này sẽ tính toán độ trễ cho từng cột
                    delay: (context) => {
                        let delay = 0;
                        if (context.type === 'data' && context.mode === 'default') {
                            // Mỗi cột sẽ xuất hiện sau cột trước đó 100ms
                            delay = context.dataIndex * 100;
                        }
                        return delay;
                    },
                }
            }
        });

    } catch (error) {
        console.error('Lỗi khi vẽ biểu đồ hoạt động:', error);
    }
}

function loadSettings() {
    const savedSettings = localStorage.getItem(`userSettings_${currentUser.uid}`);
    if (savedSettings) {
        userSettings = JSON.parse(savedSettings);
    } else {
        // Cài đặt mặc định
        userSettings = {
            theme: 'light',
            primaryColor: '#007bff',
            showStatsWidgets: true
        };
    }
    applySettings();
}

async function handleChangePassword(e) {
    e.preventDefault();
    const oldPass = document.getElementById('oldPassword').value;
    const newPass = document.getElementById('newPassword').value;
    const confirmPass = document.getElementById('confirmPassword').value;

    if (newPass !== confirmPass) {
        showToast('Mật khẩu mới không khớp!', 'danger');
        return;
    }
    if (newPass.length < 6) {
        showToast('Mật khẩu mới phải có ít nhất 6 ký tự.', 'danger');
        return;
    }

    try {
        const user = auth.currentUser;
        const credential = EmailAuthProvider.credential(user.email, oldPass);

        // Firebase yêu cầu xác thực lại trước khi đổi mật khẩu
        await reauthenticateWithCredential(user, credential);

        // Nếu xác thực thành công, tiến hành đổi mật khẩu
        await updatePassword(user, newPass);

        showToast('Đổi mật khẩu thành công!', 'success');
        document.getElementById('changePasswordForm').reset();

    } catch (error) {
        console.error("Change Password Error:", error);
        if (error.code === 'auth/wrong-password') {
            showToast('Mật khẩu cũ không chính xác.', 'danger');
        } else {
            showToast('Có lỗi xảy ra, vui lòng thử lại.', 'danger');
        }
    }
}

function initializeSettingsListeners() {

    document.getElementById('saveCompanyInfoBtn')?.addEventListener('click', saveCompanyInfo);
    // Dark Mode Switch
    document.getElementById('darkModeSwitch').addEventListener('change', (e) => {
        userSettings.theme = e.target.checked ? 'dark' : 'light';
        applySettings();
        saveSettings();
    });

    // Color Theme Selector
    document.getElementById('themeColorSelector').addEventListener('click', (e) => {
        if (e.target.matches('.color-box')) {
            userSettings.primaryColor = e.target.dataset.color;
            applySettings();
            saveSettings();
        }
    });

    // Toggle Widgets Switch
    document.getElementById('toggleStatsWidgetsSwitch').addEventListener('change', (e) => {
        userSettings.showStatsWidgets = e.target.checked;
        applySettings();
        saveSettings();
    });
    document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);

    const maintenanceSwitch = document.getElementById('maintenanceModeSwitch');
    if (maintenanceSwitch) {
        // Tải trạng thái ban đầu của nút
        const maintenanceRef = doc(db, 'settings', 'maintenance');
        getDoc(maintenanceRef).then(docSnap => {
            if (docSnap.exists()) {
                maintenanceSwitch.checked = docSnap.data().enabled;
            }
        });
        maintenanceSwitch.addEventListener('change', async (e) => {
            const isEnabled = e.target.checked;
            try {
                await setDoc(doc(db, 'settings', 'maintenance'), { enabled: isEnabled });
                showToast(`Chế độ bảo trì đã được ${isEnabled ? 'BẬT' : 'TẮT'}.`, isEnabled ? 'warning' : 'success');
            } catch (error) {
                console.error("Lỗi cập nhật chế độ bảo trì:", error);
                showToast("Lỗi khi cập nhật trạng thái bảo trì.", 'danger');
                e.target.checked = !isEnabled; // Hoàn tác lại trạng thái nút nếu có lỗi
            }
        });
    }
}

function initializeDashboardFilters() {
    document.getElementById('exportDashboardExcel')?.addEventListener('click', exportDashboardToExcel);
    document.getElementById('dashboardCodeFilter')?.addEventListener('input', debounce(() => loadInventoryTable(true, 1), 500));
    document.getElementById('dashboardCategoryFilter')?.addEventListener('change', () => loadInventoryTable(true, 1));
    document.getElementById('dashboardStockFilter')?.addEventListener('change', () => loadInventoryTable(true, 1));
    loadCategoriesForFilter();
    loadInventoryTable(false, 1);
}

async function loadCategoriesForFilter() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'));
        const snapshot = await getDocs(inventoryQuery);
        const categories = new Set();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.category) {
                categories.add(data.category);
            }
        });
        const select = document.getElementById('dashboardCategoryFilter');
        if (select) {
            select.innerHTML = '<option value="">Tất cả danh mục</option>';

            [...categories].sort().forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                select.appendChild(option);
            });
        }

    } catch (error) {
        console.error('Error loading categories:', error);
    }
}

function exportDashboardToExcel() {
    if (filteredDashboardData.length === 0) {
        showToast('Không có dữ liệu để xuất', 'warning');
        return;
    }
    const excelData = [
        ['Mã hàng', 'Tên mô tả', 'Đơn vị tính', 'Số lượng', 'Danh mục', 'Vị trí']
    ];

    filteredDashboardData.forEach(item => {
        excelData.push([
            item.code,
            item.name,
            item.unit,
            item.quantity,
            item.category,
            item.location
        ]);
    });

    // Create workbook
    const ws = XLSX.utils.aoa_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tồn kho');

    // Generate filename with timestamp
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `ton-kho-${timestamp}.xlsx`;

    // Download file
    XLSX.writeFile(wb, filename);
    showToast('Đã xuất Excel thành công', 'success');
}

async function openLayoutViewer() {
    try {
        if (allInventoryDataForLayout.length === 0) {
            const snapshot = await getDocs(query(collection(db, 'inventory')));
            allInventoryDataForLayout = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        }
        goBackToAllAislesView();
        layoutViewerModalInstance.show();
    } catch (error) {
        console.error("Error opening layout viewer:", error);
        showToast("Lỗi khi tải dữ liệu layout kho.", "danger");
    }
}

window.openPrintLayoutModal = function () {
    const selector = document.getElementById('printAisleSelector');
    selector.innerHTML = layoutConfig.aisles.map(a => `<option value="${a}">Dãy ${a}</option>`).join('');
    layoutPrintModalInstance.show();
}

window.generateLayoutPdf = async function () {
    const btn = document.getElementById('generatePdfBtn');
    const btnText = document.getElementById('pdfBtnText');
    const spinner = document.getElementById('pdfSpinner');

    btn.disabled = true;
    btnText.textContent = 'Đang tạo...';
    spinner.style.display = 'inline-block';

    try {
        const arrayBufferToBase64 = (buffer) => {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            const len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        };
        const [
            fontRegularBuffer,
            fontItalicBuffer,
        ] = await Promise.all([
            fetch('/fonts/Roboto-Regular.ttf').then(res => res.arrayBuffer()),
            fetch('/fonts/Roboto-Italic.ttf').then(res => res.arrayBuffer()),
        ]);

        const fontRegularBase64 = arrayBufferToBase64(fontRegularBuffer);
        const fontItalicBase64 = arrayBufferToBase64(fontItalicBuffer);
        const selectedAisle = document.getElementById('printAisleSelector').value;
        const statusFilter = document.querySelector('input[name="printStatusFilter"]:checked').value;
        const activeInventory = allInventoryDataForLayout.filter(item => item.status !== 'archived');
        const tableData = [];
        const aisleItems = activeInventory.filter(item => item.location.startsWith(selectedAisle));
        const itemMap = new Map();
        aisleItems.forEach(item => {
            if (!itemMap.has(item.location)) {
                itemMap.set(item.location, []);
            }
            itemMap.get(item.location).push(item);
        });

        for (let i = 1; i <= layoutConfig.maxBay; i++) {
            for (let j = 1; j <= layoutConfig.maxLevel; j++) {
                const locationCode = `${selectedAisle}${i}-${j.toString().padStart(2, '0')}`;
                const itemsInLevel = itemMap.get(locationCode) || [];
                const hasStock = itemsInLevel.some(item => item.quantity > 0);

                if (statusFilter === 'all' || (statusFilter === 'occupied' && hasStock) || (statusFilter === 'empty' && !hasStock)) {
                    if (hasStock) {
                        itemsInLevel.forEach(item => {
                            if (item.quantity > 0) {
                                tableData.push([item.code, locationCode, item.quantity]);
                            }
                        });
                    } else {
                        if (statusFilter !== 'occupied') {
                            tableData.push(['-', locationCode, '-']);
                        }
                    }
                }
            }
        }

        if (tableData.length === 0) {
            showToast("Không có dữ liệu phù hợp để xuất.", "warning");
            btn.disabled = false;
            btnText.textContent = 'Xuất PDF';
            spinner.style.display = 'none';
            return;
        }

        const finalTableData = tableData.map((row, index) => [index + 1, ...row]);
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        pdf.addFileToVFS('Roboto-Regular.ttf', fontRegularBase64);
        pdf.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
        pdf.addFileToVFS('Roboto-Italic.ttf', fontItalicBase64);
        pdf.addFont('Roboto-Italic.ttf', 'Roboto', 'italic');
        pdf.setFont('Roboto', 'normal'); // Bắt đầu với font thường

        const timestamp = new Date().toLocaleString('vi-VN');
        const title = `DANH SÁCH VỊ TRÍ KHO - DÃY ${selectedAisle}`;
        const filterText = `Trạng thái: ${statusFilter === 'all' ? 'Tất cả' : (statusFilter === 'occupied' ? 'Có hàng' : 'Trống')}`;
        const filterText1 = `${statusFilter === 'all' ? 'Tat ca' : (statusFilter === 'occupied' ? 'Co hang' : 'Trong')}`;
        const note = `${selectedAisle} là dãy ${selectedAisle} - 1 là kệ thứ 1 - 01 là tầng 1`;

        pdf.setFontSize(16);
        pdf.text(title, 105, 15, { align: 'center' });
        pdf.setFontSize(10);
        pdf.text(filterText, 105, 20, { align: 'center' });
        pdf.text(`Ngày xuất: ${timestamp}`, 105, 25, { align: 'center' });
        pdf.setFont('Roboto', 'italic');
        pdf.text(note, 15, 30, { align: 'left' });
        pdf.setFont('Roboto', 'normal');

        pdf.autoTable({
            head: [['STT', 'Mã hàng', 'Vị trí', 'Số lượng']],
            body: finalTableData,
            startY: 35,
            theme: 'grid',
            styles: { font: 'Roboto', fontSize: 9 },
            headStyles: { font: 'Roboto', fontStyle: 'bold', fillColor: [41, 128, 185], textColor: 255 },
        });

        const filenameTimestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-');
        pdf.save(`danh-sach-vi-tri_day-${selectedAisle}-${filterText1}_${filenameTimestamp}.pdf`);
        layoutPrintModalInstance.hide();
    } catch (error) {
        console.error("Lỗi tạo PDF:", error);
        showToast("Đã xảy ra lỗi khi tạo file PDF.", "danger");
    } finally {
        btn.disabled = false;
        btnText.textContent = 'Xuất PDF';
        spinner.style.display = 'none';
    }
}

async function fetchLayoutConfiguration() {
    try {
        const configDocRef = doc(db, 'settings', 'layoutConfiguration');
        const docSnap = await getDoc(configDocRef);
        if (docSnap.exists()) {
            layoutConfig = docSnap.data();
        } else {
            const defaultConfig = {
                aisles: ['A', 'B', 'C'],
                maxBay: 10,
                maxLevel: 4
            };
            await setDoc(configDocRef, defaultConfig);
            layoutConfig = defaultConfig;
        }
    } catch (error) {
        console.error("Error fetching layout config:", error);
        layoutConfig = { aisles: ['A'], maxBay: 1, maxLevel: 1 };
    }
}

window.openLayoutSettingsModal = function () {
    document.getElementById('maxBayInput').value = layoutConfig.maxBay;
    document.getElementById('maxLevelInput').value = layoutConfig.maxLevel;
    const checklist = document.getElementById('aisleChecklist');
    checklist.innerHTML = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split('').map(char => `
        <div class="form-check aisle-checkbox-item">
            <input class="form-check-input" type="checkbox" value="${char}" id="aisle_${char}" ${layoutConfig.aisles.includes(char) ? 'checked' : ''}>
            <label class="form-check-label" for="aisle_${char}">Dãy ${char}</label>
        </div>`).join('');
    if (layoutSettingsModalInstance) {
        layoutSettingsModalInstance.show();
    }
}

window.saveLayoutConfiguration = async function () {
    try {
        const selectedAisles = Array.from(document.querySelectorAll('#aisleChecklist input:checked')).map(input => input.value);
        const newConfig = {
            aisles: selectedAisles.sort(),
            maxBay: parseInt(document.getElementById('maxBayInput').value) || 10,
            maxLevel: parseInt(document.getElementById('maxLevelInput').value) || 4,
        };
        await setDoc(doc(db, 'settings', 'layoutConfiguration'), newConfig);
        layoutConfig = newConfig;
        showToast("Đã lưu cài đặt layout thành công!", "success");
        if (layoutSettingsModalInstance) {
            layoutSettingsModalInstance.hide();
        }
        openLayoutViewer();
    } catch (error) {
        console.error("Error saving layout config:", error);
        showToast("Lỗi khi lưu cài đặt.", "danger");
    }
}

function drawAllAislesLayout(inventoryData) {
    const legend = document.querySelector('.layout-legend');
    if (legend) {
        legend.style.display = 'none';
    }
    const drawingArea = document.getElementById('layoutDrawingArea');
    drawingArea.innerHTML = '';
    drawingArea.className = 'all-aisles-container';

    layoutConfig.aisles.forEach(aisle => {
        const aisleColumn = document.createElement('div');
        aisleColumn.className = 'aisle-column';
        aisleColumn.innerHTML = `<div class="aisle-column-header">${aisle}</div>`;
        aisleColumn.title = `Nhấn để xem chi tiết dãy ${aisle}`;
        aisleColumn.onclick = () => switchToDetailedView(aisle);

        const aisleBody = document.createElement('div');
        aisleBody.className = 'aisle-column-body';

        for (let levelNum = layoutConfig.maxLevel; levelNum >= 1; levelNum--) {
            const levelCode = levelNum.toString().padStart(2, '0');
            const itemsInLevel = inventoryData.filter(item =>
                item.location.startsWith(aisle) && item.location.endsWith(`-${levelCode}`)
            );
            const baysWithItems = new Set(
                itemsInLevel.map(item => {
                    const match = item.location.match(new RegExp(`^${aisle}(\\d+)-`));
                    return match ? match[1] : null;
                }).filter(Boolean)
            );
            const occupiedBayCount = baysWithItems.size;

            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'aisle-level-summary';
            if (occupiedBayCount > 0) {
                summaryDiv.classList.add('has-items');
            } else {
                summaryDiv.classList.add('is-empty');
            }
            summaryDiv.innerHTML = `
                <span>Tầng ${levelNum}</span>
                <span class="level-summary-count">${occupiedBayCount} / ${layoutConfig.maxBay}</span>
            `;
            aisleBody.appendChild(summaryDiv);
        }
        aisleColumn.appendChild(aisleBody);
        drawingArea.appendChild(aisleColumn);
    });
}

function drawAisleLayout(selectedAisle, inventoryData) {
    const legend = document.querySelector('.layout-legend');
    if (legend) {
        legend.style.display = 'flex'; // Sử dụng 'flex' để hiển thị lại đúng như CSS gốc
    }
    const drawingArea = document.getElementById('layoutDrawingArea');
    drawingArea.innerHTML = '';
    drawingArea.className = 'layout-container';

    const aisleItems = inventoryData.filter(item => item.location.startsWith(selectedAisle));
    const bays = {};
    aisleItems.forEach(item => {
        const match = item.location.match(/(\d+)-(\d+)/);
        if (match) {
            const bayNum = parseInt(match[1], 10);
            if (!bays[bayNum]) bays[bayNum] = [];
            bays[bayNum].push(item);
        }
    });

    const { maxBay, maxLevel } = layoutConfig;

    for (let i = 1; i <= maxBay; i++) {
        const bayDiv = document.createElement('div');
        bayDiv.className = 'layout-bay';
        bayDiv.innerHTML = `<div class="bay-label">Kệ ${i}</div>`;

        for (let j = maxLevel; j >= 1; j--) {
            const levelDiv = document.createElement('div');
            levelDiv.className = 'layout-level';
            const levelCode = j.toString().padStart(2, '0');
            const locationCode = `${selectedAisle}${i}-${levelCode}`;
            const itemsInLevel = (bays[i] || []).filter(item => item.location === locationCode);

            levelDiv.innerHTML = `<span class="level-label">Tầng ${j}</span>`;

            let tooltipHtml = `<div class="custom-tooltip-content"><div class="tooltip-header">${locationCode}</div>`;
            if (itemsInLevel.length > 0) {
                tooltipHtml += `<ul class="tooltip-list">`;
                itemsInLevel.forEach(item => {
                    tooltipHtml += `<li><span>- ${item.code}:</span> <span>${item.quantity}</span></li>`;
                });
                tooltipHtml += `</ul>`;
            } else {
                tooltipHtml += `<div style="margin-top: 0.5rem; color: var(--text-muted-color);">(Trống)</div>`;
            }
            tooltipHtml += `</div>`;

            if (itemsInLevel.length === 0) {
                levelDiv.classList.add('level-empty');
            } else {
                const hasMultiCode = new Set(itemsInLevel.map(it => it.code)).size > 1;
                if (hasMultiCode) {
                    levelDiv.classList.add('level-multi-item');
                    levelDiv.innerHTML += `<div class="level-content">${itemsInLevel.length} loại SP</div>`;
                } else {
                    const item = itemsInLevel[0];
                    const statusClass = item.quantity < 10 ? 'level-low' : 'level-full';
                    levelDiv.classList.add(statusClass);
                    levelDiv.innerHTML += `<div class="level-content">${item.code}<br>SL: ${item.quantity}</div>`;
                }
            }

            levelDiv.setAttribute('data-bs-toggle', 'tooltip');
            levelDiv.setAttribute('data-bs-placement', 'top');
            levelDiv.setAttribute('data-bs-html', 'true');
            levelDiv.setAttribute('title', tooltipHtml);
            levelDiv.onclick = () => showLocationDetails(locationCode, itemsInLevel);
            bayDiv.appendChild(levelDiv);
        }
        drawingArea.appendChild(bayDiv);
    }
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(tooltip => new bootstrap.Tooltip(tooltip));
}

function switchToDetailedView(aisle) {
    const activeInventory = allInventoryDataForLayout.filter(item => item.status !== 'archived');
    const backButton = document.getElementById('layoutBackBtn');
    drawAisleLayout(aisle, activeInventory);
    if (backButton) backButton.style.display = 'inline-block';
}

function showLocationDetails(locationCode, items) {
    let modalBodyHtml = '';
    if (items.length === 0) {
        modalBodyHtml = '<p class="text-muted">Vị trí này đang trống.</p>';
    } else {
        modalBodyHtml = items.map(item => `
            <div class="card mb-2">
                <div class="card-body py-2 px-3">
                    <h6 class="card-title mb-1">${item.name} (${item.code})</h6>
                    <p class="card-text mb-0"><small><strong>Số lượng:</strong> ${item.quantity} ${item.unit} | <strong>Danh mục:</strong> ${item.category}</small></p>
                </div>
            </div>
        `).join('');
    }

    const detailsModal = document.createElement('div');
    detailsModal.className = 'modal fade';
    detailsModal.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Chi tiết vị trí: ${locationCode}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">${modalBodyHtml}</div>
            </div>
        </div>
    `;

    document.body.appendChild(detailsModal);
    const bsModal = new bootstrap.Modal(detailsModal);
    bsModal.show();
    detailsModal.addEventListener('hidden.bs.modal', () => detailsModal.remove());
}

async function showUserProfileModal() {
    const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
    const userData = userDoc.data();

    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'userProfileModal';
    modal.setAttribute('tabindex', '-1');

    modal.innerHTML = `
        <div class="modal-dialog modal-lg modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header"><h5 class="modal-title"><i class="fas fa-user-edit me-2"></i>Thông tin cá nhân</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
                <div class="modal-body">
                    <div id="profileViewMode">
                        <div class="profile-modal-grid">
                            <label>Họ và tên:</label> <span>${userData.name}</span>
                            <label>Email:</label> <span>${userData.email}</span>
                            <label>Chức vụ:</label> <span>${userData.position || '<em>Chưa cập nhật</em>'}</span>
                            <label>Bộ phận:</label> <span>${userData.department || '<em>Chưa cập nhật</em>'}</span>
                            <label>Số điện thoại:</label> <span>${userData.phone || '<em>Chưa cập nhật</em>'}</span>
                            <label>Quản lý trực tiếp:</label> <span>${userData.isHighestAuthority ? '<span class="badge bg-danger">Quyền cao nhất</span>' : (userData.manager || '<em>Chưa cập nhật</em>')}</span>
                        </div>
                    </div>
                    <div id="profileEditMode" style="display:none;">
                        <div class="profile-modal-grid">
                            <label for="profilePosition">Chức vụ:</label> <input type="text" id="profilePosition" class="form-control" value="${userData.position || ''}">
                            <label for="profileDepartment">Bộ phận:</label> <input type="text" id="profileDepartment" class="form-control" value="${userData.department || ''}">
                            <label for="profilePhone">Số điện thoại:</label> <input type="text" id="profilePhone" class="form-control" value="${userData.phone || ''}">
                            <label for="profileManager">Quản lý trực tiếp:</label>
                            <div class="w-100">
                                <div class="autocomplete-container-compact">
                                    <input type="text" id="profileManager" class="form-control" value="${userData.manager || ''}" placeholder="Tìm theo tên hoặc email...">
                                    <div class="suggestion-dropdown-compact" id="profileManagerSuggestions" style="display: none;"></div>
                                </div>
                                <!-- THÊM MỚI: Checkbox quyền cao nhất -->
                                <div class="form-check highest-authority-toggle">
                                    <input class="form-check-input" type="checkbox" id="profileIsHighest" ${userData.isHighestAuthority ? 'checked' : ''}>
                                    <label class="form-check-label" for="profileIsHighest">Đặt làm quyền cao nhất (CEO/Giám đốc)</label>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" id="profileCancelBtn" style="display:none;">Hủy</button>
                    <button type="button" class="btn btn-primary" id="profileEditBtn">Sửa thông tin</button>
                    <button type="button" class="btn btn-success" id="profileSaveBtn" style="display:none;">Lưu thay đổi</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.querySelector('#profileEditBtn').onclick = () => {
        toggleProfileEditMode(true);
        // Kích hoạt kiểm tra trạng thái ban đầu khi vào chế độ sửa
        handleHighestAuthorityToggle('profile');
    };
    modal.querySelector('#profileCancelBtn').onclick = () => toggleProfileEditMode(false);
    modal.querySelector('#profileSaveBtn').onclick = () => saveUserProfile(currentUser.uid); // Pass UID

    const managerInput = modal.querySelector('#profileManager');
    managerInput.addEventListener('input', (e) => handleManagerSearch(e, 'profile', currentUser.uid));
    managerInput.addEventListener('blur', () => setTimeout(() => hideSuggestions('profileManagerSuggestions'), 200));

    // THÊM MỚI: Sự kiện cho checkbox
    modal.querySelector('#profileIsHighest').addEventListener('change', () => handleHighestAuthorityToggle('profile'));

    modal.addEventListener('hidden.bs.modal', () => modal.remove());
    bsModal.show();
}

function toggleProfileEditMode(isEditing) {
    document.getElementById('profileViewMode').style.display = isEditing ? 'none' : 'block';
    document.getElementById('profileEditMode').style.display = isEditing ? 'block' : 'none';

    document.getElementById('profileEditBtn').style.display = isEditing ? 'none' : 'inline-block';
    document.getElementById('profileSaveBtn').style.display = isEditing ? 'inline-block' : 'none';
    document.getElementById('profileCancelBtn').style.display = isEditing ? 'inline-block' : 'none';
}

function handleHighestAuthorityToggle(prefix) {
    const isHighestCheckbox = document.getElementById(`${prefix}IsHighest`);
    const managerInput = document.getElementById(`${prefix}Manager`);

    if (isHighestCheckbox.checked) {
        managerInput.value = '';
        managerInput.disabled = true;
        managerInput.placeholder = 'Không có quản lý trực tiếp';
    } else {
        managerInput.disabled = false;
        managerInput.placeholder = 'Tìm theo tên hoặc email...';
    }
}

function initializeAllListeners() {
    // Sử dụng một cờ (flag) trên đối tượng window để đảm bảo chỉ chạy một lần
    if (window.allListenersInitialized) {
        return;
    }

    // Gọi tất cả các hàm khởi tạo listener ở đây
    updateUserManagementBadge(); // Vẫn giữ ở đây để cập nhật lần đầu
    initializeRealtimeBadges();
    
    // Bạn cũng có thể gom các hàm onSnapshot khác vào đây trong tương lai
    
    window.allListenersInitialized = true; // Đánh dấu là đã khởi tạo
}

async function saveUserProfile(userId) {
    // Lấy trạng thái của checkbox quyền cao nhất
    const isHighest = document.getElementById('profileIsHighest').checked;

    const dataToUpdate = {
        position: document.getElementById('profilePosition').value.trim(),
        department: document.getElementById('profileDepartment').value.trim(),
        phone: document.getElementById('profilePhone').value.trim(),
        manager: isHighest ? '' : document.getElementById('profileManager').value.trim(),
        isHighestAuthority: isHighest,
    };

    try {
        const batch = writeBatch(db);

        // Nếu đặt người này làm quyền cao nhất, tìm và hạ quyền người cũ
        if (isHighest) {
            const oldHighest = allUsersCache.find(u => u.isHighestAuthority && u.uid !== userId);
            if (oldHighest) {
                const oldHighestRef = doc(db, 'users', oldHighest.uid);
                batch.update(oldHighestRef, { isHighestAuthority: false });
            }
        }

        const userRef = doc(db, 'users', userId);
        batch.update(userRef, dataToUpdate);

        await batch.commit();

        showToast('Cập nhật thông tin cá nhân thành công!', 'success');

        await fetchAllUsersForCache(true);
        if (document.getElementById('org-chart-section').style.display === 'block') {
            renderOrganizationChart();
        }

        bootstrap.Modal.getInstance(document.getElementById('userProfileModal')).hide();
    } catch (error) {
        console.error("Lỗi khi cập nhật profile:", error);
        showToast('Đã có lỗi xảy ra khi lưu thông tin.', 'danger');
    }
}

function initializeRealtimeBadges() {
     if (userRole !== 'admin' && userRole !== 'super_admin') return;
    // 1. Lắng nghe các yêu cầu CHỈNH SỐ đang chờ duyệt
    const adjustQuery = query(collection(db, 'adjustment_requests'), where('status', '==', 'pending'));
    onSnapshot(adjustQuery, (snapshot) => {
        updateBadge('adjustRequestBadge', snapshot.size);
    }, (error) => console.error("Lỗi lắng nghe yêu cầu chỉnh số:", error));

    // 2. Lắng nghe các phiếu NHẬP KHO đang chờ QC
    const importQuery = query(collection(db, 'transactions'), where('type', '==', 'import'));
    onSnapshot(importQuery, (snapshot) => {
        let pendingQcCount = 0;
        snapshot.forEach(doc => {
            const hasPendingQc = doc.data().items?.some(item => item.qc_status === 'pending');
            if (hasPendingQc) {
                pendingQcCount++;
            }
        });
        updateBadge('importRequestBadge', pendingQcCount);
    }, (error) => console.error("Lỗi lắng nghe phiếu chờ QC:", error));

    // --- BƯỚC 2: THÊM KHỐI CODE NÀY VÀO ---
    // 3. Lắng nghe các yêu cầu XUẤT KHO đang chờ duyệt
    const exportQuery = query(collection(db, 'export_requests'), where('status', '==', 'pending'));
    onSnapshot(exportQuery, (snapshot) => {
        updateBadge('exportRequestBadge', snapshot.size);
    }, (error) => console.error("Lỗi lắng nghe yêu cầu xuất kho:", error));
    // --- KẾT THÚC THÊM ---
}


document.addEventListener('visibilitychange', () => {
    // Nếu tab trở nên hiển thị và người dùng đã đăng nhập
    if (document.visibilityState === 'visible' && auth.currentUser) {
        // Gọi lại các hàm cập nhật để lấy dữ liệu mới nhất
        updateUserManagementBadge();
        initializeRealtimeBadges(); // Hàm này chứa onSnapshot, nó sẽ tự động kết nối lại
    }
});