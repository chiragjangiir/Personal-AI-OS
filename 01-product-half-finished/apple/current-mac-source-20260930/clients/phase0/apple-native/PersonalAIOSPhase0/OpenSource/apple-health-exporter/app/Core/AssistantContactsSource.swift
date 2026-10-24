import Contacts
import Foundation

struct AssistantContact: Codable, Equatable, Sendable {
    struct Phone: Codable, Equatable, Sendable { let number: String; let label: String }
    /// Directed from this card to the related person's name. Never an inferred relation to the owner.
    struct Relation: Codable, Equatable, Sendable { let label: String; let name: String }
    let id: String
    let name: String
    let phones: [Phone]
    let relations: [Relation]
    func validate() throws {
        guard !id.isEmpty, id.unicodeScalars.count <= 256, name.unicodeScalars.count <= 160,
              phones.count <= 16, relations.count <= 16,
              phones.allSatisfy({ !$0.number.isEmpty && $0.number.unicodeScalars.count <= 80 && $0.label.unicodeScalars.count <= 80 }),
              relations.allSatisfy({ !$0.label.isEmpty && $0.label.unicodeScalars.count <= 80 && !$0.name.isEmpty && $0.name.unicodeScalars.count <= 160 })
        else { throw AssistantContactsFailure.invalidCard }
    }
}
struct AssistantContactsSnapshot: Sendable { let contacts: [AssistantContact]; let limited: Bool }
enum AssistantContactsFailure: Error, Sendable { case permission, invalidCard, duplicateID, packetTooLarge }
protocol AssistantContactsReading: Sendable {
    func requestAccess() async throws
    func snapshot() async throws -> AssistantContactsSnapshot
    func verifyAccess(limited: Bool) async throws
}
extension AssistantContactsReading { func verifyAccess(limited: Bool) async throws {} }

/// Read-only Contacts source. Successful complete enumeration is the only deletion authority.
actor SystemAssistantContactsSource: AssistantContactsReading {
    private let store = CNContactStore()
    private static func readable(_ status: CNAuthorizationStatus) -> Bool {
        if status == .authorized { return true }
#if os(iOS)
        if #available(iOS 18.0, *), status == .limited { return true }
#endif
        return false
    }
    func requestAccess() async throws {
        if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
            _ = try await store.requestAccess(for: .contacts)
        }
        guard Self.readable(CNContactStore.authorizationStatus(for: .contacts)) else { throw AssistantContactsFailure.permission }
    }
    func verifyAccess(limited: Bool) async throws {
        let access = CNContactStore.authorizationStatus(for: .contacts)
        guard Self.readable(access), (access != .authorized) == limited else { throw AssistantContactsFailure.permission }
    }
    func snapshot() async throws -> AssistantContactsSnapshot {
        let access = CNContactStore.authorizationStatus(for: .contacts)
        guard Self.readable(access) else { throw AssistantContactsFailure.permission }
        let keys: [CNKeyDescriptor] = [CNContactIdentifierKey as CNKeyDescriptor,
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactRelationsKey as CNKeyDescriptor]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true
        var cards: [AssistantContact] = []
        var failure: Error?
        try store.enumerateContacts(with: request) { contact, stop in
            do {
                try Task.checkCancellation()
                let card = AssistantContact(id: contact.identifier, name: CNContactFormatter.string(from: contact, style: .fullName) ?? "",
                    phones: contact.phoneNumbers.map { .init(number: $0.value.stringValue, label: Self.label($0.label)) },
                    relations: contact.contactRelations.map { .init(label: Self.label($0.label, relation: true), name: $0.value.name) })
                try card.validate(); cards.append(card)
            } catch { failure = error; stop.pointee = true }
        }
        if let failure { throw failure }
        try Task.checkCancellation()
        guard CNContactStore.authorizationStatus(for: .contacts) == access else { throw AssistantContactsFailure.permission }
        return AssistantContactsSnapshot(contacts: cards, limited: access != .authorized)
    }
    static func label(_ value: String?, relation: Bool = false) -> String {
        guard let value, !value.isEmpty else { return relation ? "相关人" : "" }
        let chinese = [CNLabelContactRelationMother: "妈妈", CNLabelContactRelationFather: "爸爸",
            CNLabelContactRelationParent: "父母", CNLabelContactRelationSister: "姐妹", CNLabelContactRelationBrother: "兄弟",
            CNLabelContactRelationChild: "子女", CNLabelContactRelationSpouse: "配偶", CNLabelContactRelationPartner: "伴侣",
            CNLabelContactRelationFriend: "朋友", CNLabelContactRelationManager: "经理", CNLabelContactRelationAssistant: "助理",
            CNLabelHome: "住宅", CNLabelWork: "工作", CNLabelPhoneNumberMobile: "手机", CNLabelPhoneNumberMain: "主要"]
        return chinese[value] ?? CNLabeledValue<NSString>.localizedString(forLabel: value)
    }
}
