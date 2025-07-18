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
} from './warehouse.js';

import { auth, db } from './connect.js';
export let companyInfo = { name: '', address: '' };
export { currentUser, userRole }; 
import { onAuthStateChanged, signOut,EmailAuthProvider,          // <-- THÊM VÀO
    reauthenticateWithCredential, // <-- THÊM VÀO
    updatePassword } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
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
    addDoc,        // Thêm dòng này
    updateDoc,     // Thêm dòng này
    serverTimestamp,
    writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { showToast } from './auth.js';

let currentUser = null;
let userRole = null;
let currentDashboardPage = 1;
let dashboardItemsPerPage = 15;
let filteredDashboardData = [];
let allDashboardData = [];
let userSettings = {};

let layoutViewerModalInstance = null;
let layoutSettingsModalInstance = null;
let layoutPrintModalInstance = null; 
let layoutConfig = {
    aisles: ['A', 'B', 'C'], // Mặc định
    maxBay: 10,
    maxLevel: 4
};
let allInventoryDataForLayout = [];

window.loadInventoryTable = loadInventoryTable;
window.goToDashboardPage = goToDashboardPage;

// Trong file dashboard.js

document.addEventListener('DOMContentLoaded', function () {
    loadCacheData(); 
    initializeNavigation();
    initializeAuth();
    initializeSettingsListeners();
    initializeWarehouseFunctions(); 
    
    // Khởi tạo tất cả các đối tượng Modal một lần duy nhất
    const layoutViewerEl = document.getElementById('layoutViewerModal');
    if(layoutViewerEl) {
        layoutViewerModalInstance = new bootstrap.Modal(layoutViewerEl);
    }
    const layoutSettingsEl = document.getElementById('layoutSettingsModal');
    if(layoutSettingsEl) {
        layoutSettingsModalInstance = new bootstrap.Modal(layoutSettingsEl);
    }
    const layoutPrintEl = document.getElementById('layoutPrintModal');
    if(layoutPrintEl) {
        layoutPrintModalInstance = new bootstrap.Modal(layoutPrintEl);
    }

    document.getElementById('openLayoutViewerBtn')?.addEventListener('click', openLayoutViewer);
    document.getElementById('layoutBackBtn')?.addEventListener('click', goBackToAllAislesView);
});



function goBackToAllAislesView() {
    const activeInventory = allInventoryDataForLayout.filter(item => item.status !== 'archived');
    const backButton = document.getElementById('layoutBackBtn');
    drawAllAislesLayout(activeInventory);
    if(backButton) backButton.style.display = 'none';
}

function goToDashboardPage(page) {
    if (page >= 1) {
        loadInventoryTable(true, page);
    }
}

// Initialize authentication state
function initializeAuth() { 
    onAuthStateChanged(auth, async (user) => {
        
        if (!user) {
            window.location.href = 'index.html';
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
                
                await loadCompanyInfo();
                loadSettings();

                setupUserInterface();
                initializeSidebarToggle();
                loadDashboardData();
                updateUserManagementBadge();
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

// Thêm 2 hàm MỚI này vào file dashboard.js

async function loadCompanyInfo() {
    try {
        const docRef = doc(db, 'settings', 'companyInfo');
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            companyInfo = docSnap.data();
        } else {
            // Nếu chưa có, giữ giá trị mặc định
            companyInfo = { name: 'TÊN CÔNG TY', address: 'ĐỊA CHỈ CÔNG TY' };
        }
        
        // Cập nhật giá trị vào các ô input trong tab Cài đặt
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
        
        // Cập nhật lại biến toàn cục
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
    document.getElementById('logoutBtn').addEventListener('click', async () => {
        try {
            await signOut(auth);
            window.location.href = 'index.html';
        } catch (error) {
            showToast('Lỗi đăng xuất', 'danger');
        }
    });
}


// Initialize navigation
function initializeNavigation() {
    const navLinks = document.querySelectorAll('.nav-link[data-section]');

    navLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();

            // Remove active class from all links
            navLinks.forEach(l => l.classList.remove('active'));

            // Add active class to clicked link
            this.classList.add('active');

            // Show corresponding section
            const section = this.getAttribute('data-section');
            showSection(section);
        });
    });
}

// Show specific section
function showSection(sectionName) {
    // Hide all sections
    document.querySelectorAll('.content-section').forEach(section => {
        section.style.display = 'none';
    });

    // Show selected section
    const targetSection = document.getElementById(`${sectionName}-section`);
    if (targetSection) {
        targetSection.style.display = 'block';

        // Load section-specific data
        loadSectionData(sectionName);
    }
}

// Load section-specific data
function loadSectionData(sectionName) {
    switch (sectionName) {
        case 'dashboard':
            loadDashboardData();
            break;
        case 'import':
            // Gọi trực tiếp hàm đã import
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
            if (userRole === 'super_admin') {
                loadUserManagementSection();
            }
            break;
    }
}


// Load dashboard data
async function loadDashboardData() {
    try {
        await loadInventorySummary();
        await loadTodayStatistics();
        await loadInventoryTable();
        initializeDashboardFilters();

    } catch (error) {
        console.error('Error loading dashboard data:', error);
        showToast('Lỗi tải dữ liệu dashboard', 'danger');
    }
}

// Load inventory summary
async function loadInventorySummary() {
    try {
        const inventoryQuery = query(collection(db, 'inventory'));
        const snapshot = await getDocs(inventoryQuery);

        let totalProducts = 0;
        let lowStock = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.status !== 'archived') {
                totalProducts++;
                if (data.quantity < 10) { // Low stock threshold is 10
                    lowStock++;
                }
            }
        });

        document.getElementById('totalProducts').textContent = totalProducts;
        document.getElementById('lowStock').textContent = lowStock;

    } catch (error) {
        console.error('Error loading inventory summary:', error);
    }
}

// Load today's statistics
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
    if (userRole !== 'super_admin') return;
    
    // Tải bảng lần đầu khi vào tab
    loadUsersTable();
    
    // Gán sự kiện tìm kiếm, chỉ chạy một lần
    if (!window.userManagementFiltersInitialized) {
        // Sửa các hàm gọi này để luôn quay về trang 1
        document.getElementById('userNameFilter')?.addEventListener('input', debounce(() => loadUsersTable(true, 1), 500));
        document.getElementById('userRoleFilter')?.addEventListener('change', () => loadUsersTable(true, 1));
        document.getElementById('userStatusFilter')?.addEventListener('change', () => loadUsersTable(true, 1));
        
        window.userManagementFiltersInitialized = true;
    }
}

// Thay thế toàn bộ hàm này trong dashboard.js
async function loadUsersTable(useFilter = false, page = 1) {
    if (userRole !== 'super_admin') return;

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
            content.innerHTML = '<p class="text-muted">Không tìm thấy người dùng nào.</p>';
            return;
        }

        // --- BẮT ĐẦU LOGIC PHÂN TRANG ---
        const itemsPerPage = 10; // Hiển thị 10 user mỗi trang
        const totalItems = filteredUsers.length;
        const totalPages = Math.ceil(totalItems / itemsPerPage);
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
        const pageData = filteredUsers.slice(startIndex, endIndex);
        // --- KẾT THÚC LOGIC PHÂN TRANG ---

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

        // Chỉ lặp qua dữ liệu của trang hiện tại
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
                    actionButtonsHtml = `<button class="btn btn-warning btn-sm" onclick="showEditUserModal('${user.id}')" ${isCurrentUser ? 'disabled' : ''}><i class="fas fa-edit"></i> Sửa</button>`;
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

window.goToUserPage = function(page) {
    if (page >= 1) {
        // Gọi lại hàm loadUsersTable với trang mới và vẫn sử dụng bộ lọc hiện tại
        loadUsersTable(true, page);
    }
}

window.approveUser = async function(userId, userName) {
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
        // Cập nhật trạng thái user
        batch.update(userDocRef, { status: 'approved' });

        // Ghi log giao dịch loại 'user_approval'
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

/**
 * Từ chối tài khoản người dùng đang chờ duyệt.
 */
window.rejectUser = async function(userId, userName) {
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
        // Cập nhật trạng thái user
        batch.update(userDocRef, { status: 'rejected' });

        // Ghi log giao dịch
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

/**
 * Khôi phục tài khoản đã bị từ chối về trạng thái chờ duyệt.
 */
window.restoreUser = async function(userId, userName) {
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

window.showEditUserModal = async function(userId) {
    if (userRole !== 'super_admin') return;

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

// Thay thế hàm này trong file dashboard.js
function createEditUserModal(userId, userData) {
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.id = 'editUserModal';
    modal.setAttribute('tabindex', '-1');

    // *** THÊM MỚI: Thêm vai trò QC vào danh sách ***
    const roles = [
        { value: 'staff', label: 'Staff', color: 'info', icon: 'fas fa-user' },
        { value: 'qc', label: 'QC', color: 'secondary', icon: 'fas fa-clipboard-check' }, // Thêm vai trò QC
        { value: 'admin', label: 'Admin', color: 'primary', icon: 'fas fa-user-tie' },
        { value: 'super_admin', label: 'Super Admin', color: 'danger', icon: 'fas fa-user-shield' }
    ];

    const statuses = [
        { value: 'pending', label: 'Chờ duyệt', color: 'warning', icon: 'fas fa-clock' },
        { value: 'approved', label: 'Đã phê duyệt', color: 'success', icon: 'fas fa-check-circle' },
        { value: 'rejected', label: 'Từ chối', color: 'danger', icon: 'fas fa-times-circle' },
        { value: 'disabled', label: 'Vô hiệu hóa', color: 'secondary', icon: 'fas fa-ban' }
    ];

    modal.innerHTML = `
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header bg-primary text-white">
                    <h5 class="modal-title">
                        <i class="fas fa-user-edit"></i> Chỉnh sửa người dùng
                    </h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <form id="editUserForm">
                        <!-- THÔNG TIN CƠ BẢN -->
                        <div class="row mb-3">
                            <div class="col-md-6">
                                <label class="form-label fw-bold">
                                    <i class="fas fa-user text-primary me-1"></i>Họ và tên
                                </label>
                                <input type="text" class="form-control" id="editUserName" value="${userData.name}" required>
                            </div>
                            <div class="col-md-6">
                                <label class="form-label fw-bold">
                                    <i class="fas fa-envelope text-primary me-1"></i>Email
                                </label>
                                <input type="email" class="form-control" value="${userData.email}" readonly>
                                <small class="text-muted">Không thể thay đổi</small>
                            </div>
                        </div>

                        <!-- VAI TRÒ -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">
                                <i class="fas fa-user-tag text-primary me-1"></i>Vai trò
                            </label>
                            <div class="role-selector-compact">
                                ${roles.map(role => `
                                    <div class="role-compact ${userData.role === role.value ? 'selected' : ''}" data-value="${role.value}">
                                        <i class="${role.icon} text-${role.color}"></i>
                                        <span class="badge bg-${role.color}">${role.label}</span>
                                        <i class="fas fa-check-circle text-success check-icon" style="display: ${userData.role === role.value ? 'inline' : 'none'}"></i>
                                    </div>
                                `).join('')}
                            </div>
                            <input type="hidden" id="selectedRole" value="${userData.role}">
                        </div>

                        <!-- TRẠNG THÁI -->
                        <div class="mb-3">
                            <label class="form-label fw-bold">
                                <i class="fas fa-toggle-on text-primary me-1"></i>Trạng thái
                            </label>
                            <div class="status-selector-compact">
                                ${statuses.map(status => `
                                    <div class="status-compact ${userData.status === status.value ? 'selected' : ''}" data-value="${status.value}">
                                        <i class="${status.icon} text-${status.color}"></i>
                                        <span class="badge bg-${status.color}">${status.label}</span>
                                        <i class="fas fa-check-circle text-success check-icon" style="display: ${userData.status === status.value ? 'inline' : 'none'}"></i>
                                    </div>
                                `).join('')}
                            </div>
                            <input type="hidden" id="selectedStatus" value="${userData.status}">
                        </div>

                        <!-- THÔNG TIN THÊM -->
                        <div class="row">
                            <div class="col-md-6">
                                <label class="text-muted">
                                    <i class="fas fa-calendar-alt me-1"></i>
                                    Tạo: ${userData.createdAt ? userData.createdAt.toDate().toLocaleDateString('vi-VN') : 'N/A'}
                                </label>
                            </div>
                            <div class="col-md-6 text-end">
                                <label class="text-muted" id="currentStatusPreview">
                                    <!-- Updated by JS -->
                                </label>
                            </div>
                        </div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        <i class="fas fa-times me-1"></i> Hủy
                    </button>
                    <button type="button" class="btn btn-primary" onclick="saveUserChanges('${userId}')">
                        <i class="fas fa-save me-1"></i> Lưu thay đổi
                    </button>
                </div>
            </div>
        </div>
    `;

    // Setup event listeners
    setTimeout(() => {
        setupCompactUserModalEventListeners();
        updateCompactStatusPreview();
    }, 0);

    return modal;
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
        option.addEventListener('click', function() {
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
        option.addEventListener('click', function() {
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
        option.addEventListener('click', function() {
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
        option.addEventListener('click', function() {
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

window.saveUserChanges = async function(userId) {
    if (userRole !== 'super_admin') return;

    try {
        const originalUserDoc = await getDoc(doc(db, 'users', userId));
        const originalUserData = originalUserDoc.data();

        const newName = document.getElementById('editUserName').value.trim();
        const newRole = document.getElementById('selectedRole').value;
        const newStatus = document.getElementById('selectedStatus').value;

        // Validation
        if (!newName) {
            showToast('Vui lòng nhập họ tên', 'warning');
            return;
        }

        const updateData = {};
        const changes = {};

        if (newName !== originalUserData.name) {
            updateData.name = newName;
            changes.name = { from: originalUserData.name, to: newName };
        }
        if (newRole !== originalUserData.role) {
            updateData.role = newRole;
            changes.role = { from: originalUserData.role, to: newRole };
        }
        if (newStatus !== originalUserData.status) {
            updateData.status = newStatus;
            changes.status = { from: originalUserData.status, to: newStatus };
        }

        if (Object.keys(updateData).length === 0) {
            showToast('Không có thay đổi nào để lưu.', 'info');
            return;
        }

        // Xác nhận thay đổi
        const changesList = Object.entries(changes).map(([field, change]) => {
            const fieldNames = { name: 'Họ tên', role: 'Vai trò', status: 'Trạng thái' };
            return `• ${fieldNames[field]}: ${change.from} → ${change.to}`;
        }).join('<br>');

        const confirmed = await showConfirmation(
            'Xác nhận cập nhật',
            `Bạn có chắc muốn thực hiện các thay đổi sau?<br><br>${changesList}`,
            'Cập nhật',
            'Hủy',
            'question'
        );

        if (!confirmed) return;

        const batch = writeBatch(db);

        // Cập nhật user document
        batch.update(doc(db, 'users', userId), updateData);

        // Ghi log giao dịch
        const logRef = doc(collection(db, 'transactions'));
        batch.set(logRef, {
            type: 'user_management',
            userId: userId,
            userName: newName,
            userEmail: originalUserData.email,
            changes: changes,
            performedBy: currentUser.uid,
            performedByName: currentUser.name,
            timestamp: serverTimestamp()
        });

        await batch.commit();

        showToast('Cập nhật người dùng thành công!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('editUserModal')).hide();
        loadUsersTable();
        updateUserManagementBadge();

    } catch (error) {
        console.error('Error saving user changes:', error);
        showToast('Lỗi khi lưu thay đổi', 'danger');
    }
}

// THAY THẾ TOÀN BỘ HÀM NÀY BẰNG PHIÊN BẢN MỚI

async function loadInventoryTable(useFilter = false, page = 1) {
    try {
        const inventoryQuery = query(collection(db, 'inventory'), orderBy('name'));
        const snapshot = await getDocs(inventoryQuery);
        
        allDashboardData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        let activeData = allDashboardData.filter(item => item.status !== 'archived');
        
        if (useFilter) {
            const codeFilter = document.getElementById('dashboardCodeFilter')?.value.toLowerCase();
            const categoryFilter = document.getElementById('dashboardCategoryFilter')?.value;
            const stockFilter = document.getElementById('dashboardStockFilter')?.value;
            
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
        const endIndex = Math.min(startIndex + totalItems, startIndex + dashboardItemsPerPage);
        const pageData = filteredDashboardData.slice(startIndex, endIndex);
        
        const tableHead = document.getElementById('inventoryTableHead');
        const tableBody = document.getElementById('inventoryTable');
        
        // Dọn dẹp bảng trước khi vẽ lại
        tableHead.innerHTML = '';
        tableBody.innerHTML = '';

        // --- BẮT ĐẦU TẠO TIÊU ĐỀ ĐỘNG ---
        let headerHTML = `
            <tr class="text-center">
                <th>Mã hàng</th>
                <th>Tên mô tả</th>
                <th>Đơn vị tính</th>
                <th>Số lượng</th>
                <th>Danh mục</th>
                <th>Vị trí</th>
        `;
        // Chỉ thêm cột Thao tác nếu là super_admin
        if (userRole === 'super_admin') {
            headerHTML += '<th>Thao tác</th>';
        }
        headerHTML += '</tr>';
        tableHead.innerHTML = headerHTML;
        // --- KẾT THÚC TẠO TIÊU ĐỀ ĐỘNG ---

        pageData.forEach(doc => {
            const row = document.createElement('tr');
            
            if (parseInt(doc.quantity) < 10) {
                row.classList.add('table-warning');
            }
            
            let rowHTML = `
                <td class="text-center">${doc.code}</td>
                <td class="text-center">${doc.name}</td>
                <td class="text-center">${doc.unit}</td>
                <td class="text-center">${doc.quantity}</td>
                <td class="text-center">${doc.category}</td>
                <td class="text-center">${doc.location}</td>
            `;

            // Chỉ thêm ô chứa nút nếu là super_admin
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
            
            row.innerHTML = rowHTML;
            tableBody.appendChild(row);
        });
        
        updateDashboardPagination(totalPages, page, totalItems, startIndex, endIndex);
        
    } catch (error) {
        console.error('Lỗi tải bảng tồn kho:', error);
    }
}



// Thêm hàm mới này vào dashboard.js
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
        // THAY ĐỔI TẠI ĐÂY:
        // Chỉ đóng sidebar nếu liên kết có thuộc tính [data-section].
        // Các liên kết mở menu con như "Barcode" không có thuộc tính này.
        if (navLink.hasAttribute('data-section')) {
            closeSidebar();
        }
    }
    });
}


function updateDashboardPagination(totalPages, currentPage, totalItems, startIndex, endIndex) {
    const pagination = document.getElementById('dashboardPagination');
    const paginationInfo = document.getElementById('dashboardPaginationInfo');
    
    // Update info
    paginationInfo.textContent = `Hiển thị ${startIndex + 1} - ${endIndex} của ${totalItems} kết quả`;
    
    // Create pagination HTML
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
    addPaginationEventListeners(pagination);
}

function addPaginationEventListeners(container) {
    const links = container.querySelectorAll('.page-link[data-page]');
    links.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const page = parseInt(this.dataset.page);
            if (page >= 1 && !this.parentElement.classList.contains('disabled')) {
                loadInventoryTable(true, page);
            }
        });
    });
}

// Check for pending users (admin only)
async function updateUserManagementBadge() {
    if (userRole !== 'super_admin') return;
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
    // Lưu cài đặt riêng cho người dùng hiện tại (giữ nguyên)
    localStorage.setItem(`userSettings_${currentUser.uid}`, JSON.stringify(userSettings));
    
    // THÊM DÒNG NÀY: Lưu cài đặt theme chung để trang đăng nhập có thể sử dụng
    localStorage.setItem('app_theme', userSettings.theme);
}

// 2. ÁP DỤNG CÀI ĐẶT LÊN GIAO DIỆN
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

// 3. TẢI CÀI ĐẶT KHI VÀO TRANG
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

// 4. XỬ LÝ ĐỔI MẬT KHẨU
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


// 5. KHỞI TẠO CÁC EVENT LISTENER CHO CÀI ĐẶT
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

    // Change Password Form
    document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
}

function initializeDashboardFilters() {
    // Gán sự kiện cho nút xuất Excel
    document.getElementById('exportDashboardExcel')?.addEventListener('click', exportDashboardToExcel);
    
    // Gán sự kiện tìm kiếm trực tiếp cho các bộ lọc của dashboard
    document.getElementById('dashboardCodeFilter')?.addEventListener('input', debounce(() => loadInventoryTable(true, 1), 500));
    document.getElementById('dashboardCategoryFilter')?.addEventListener('change', () => loadInventoryTable(true, 1));
    document.getElementById('dashboardStockFilter')?.addEventListener('change', () => loadInventoryTable(true, 1));
    
    // Tải danh mục cho bộ lọc
    loadCategoriesForFilter();
    
    // Tải bảng lần đầu
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

// Export Excel function - CHỈ TOAST
function exportDashboardToExcel() {
    if (filteredDashboardData.length === 0) {
        showToast('Không có dữ liệu để xuất', 'warning');
        return;
    }
    
    // Prepare data for Excel
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
        await fetchLayoutConfiguration(); 
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

window.openPrintLayoutModal = function() {
    const selector = document.getElementById('printAisleSelector');
    selector.innerHTML = layoutConfig.aisles.map(a => `<option value="${a}">Dãy ${a}</option>`).join('');
    layoutPrintModalInstance.show();
}

window.generateLayoutPdf = async function() {
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

        // Tải tất cả các font song song để tăng tốc độ
        const [
            fontRegularBuffer,
            fontItalicBuffer,
        ] = await Promise.all([
            fetch('/fonts/Roboto-Regular.ttf').then(res => res.arrayBuffer()),
            fetch('/fonts/Roboto-Italic.ttf').then(res => res.arrayBuffer()),
        ]);

        // Chuyển đổi tất cả sang Base64
        const fontRegularBase64 = arrayBufferToBase64(fontRegularBuffer);
        const fontItalicBase64 = arrayBufferToBase64(fontItalicBuffer);
        
        // --- END FIX ---

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
        
        // --- START FIX: Đăng ký tất cả các kiểu font với jsPDF ---
        pdf.addFileToVFS('Roboto-Regular.ttf', fontRegularBase64);
        pdf.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');

        pdf.addFileToVFS('Roboto-Italic.ttf', fontItalicBase64);
        pdf.addFont('Roboto-Italic.ttf', 'Roboto', 'italic');
        // --- END FIX ---
        
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

        // Chuyển sang kiểu chữ nghiêng
        pdf.setFont('Roboto', 'italic');
        pdf.text(note, 15, 30, { align: 'left' });
        // Chuyển về kiểu chữ bình thường cho các nội dung sau
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
            await setDoc(configDocRef, layoutConfig);
        }
    } catch (error) { console.error("Error fetching layout config:", error); }
}

window.openLayoutSettingsModal = function() {
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

window.saveLayoutConfiguration = async function() {
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
    if(backButton) backButton.style.display = 'inline-block';
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